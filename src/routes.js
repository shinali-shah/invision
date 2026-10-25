import express from 'express';
import { createWriteStream, mkdirSync, existsSync, rmSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pipeline as pump } from 'node:stream/promises';
import { alignBehavior, cleanFrames } from './behavior/align.js';
import { generateInsight } from './agents/insight.js';
import { buildHeatmap } from './nlp/heatmap.js';
import { inferUserLabel } from './behavior/speaker.js';
import { speechTurns } from './transcribe/crowd.js';
import { TAGS } from './agents/context.js';
import { processConversation, recoach, refreshMemory, writeFollowUp } from './pipeline.js';
import { compareConversations } from './nlp/compare.js';
import { buildBrief } from './nlp/brief.js';
import { groundedIn } from './agents/followUp.js';
import { samePerson, coachable } from './names.js';
import { STAGE_VIEWS } from './stage.js';

const STEP_ACTIONS = { accept: 'accepted', change: 'changed', dismiss: 'dismissed' };

const noStage = { publish() {}, focus() {} };

// Recorded, two voices told apart, nobody tapped which one is theirs: coaching can't start yet.
// Shruti and Sid sat like this for a day because every screen worked it out differently.
export function needsLabel(convo) {
  const turns = convo.turns ?? [];
  if (turns.length < 2 || convo.userLabel) return false;
  return new Set(turns.map(t => t.speaker).filter(s => s && s !== 'unknown')).size >= 2;
}
const flagged = convo => ({ ...convo, needsLabel: needsLabel(convo) });

// The conversation this one gets measured against: last time with the same person, else just last time.
function previousFor(store, convo) {
  const all = store.listConversations();
  const earlier = all.slice(0, all.findIndex(c => c.id === convo.id)).filter(coachable);
  return earlier.filter(c => samePerson(c.otherName, convo.otherName)).at(-1) ?? earlier.at(-1) ?? null;
}

export function createApp({ store, llm, log, config, publicDir = 'public', stage = noStage, recordingsDir = 'data/recordings' }) {
  const app = express();
  app.use(express.json({ limit: '5mb' }));

  const fail = (res, status, error) => res.status(status).json({ error });

  // resolves :id or answers 404 itself
  const findConvo = (req, res) => {
    const convo = store.getConversation(req.params.id);
    if (!convo) fail(res, 404, 'Conversation not found');
    return convo;
  };

  app.get('/api/health', (req, res) => res.json({ ok: true, mock: config.mock }));
  app.get('/api/me', (req, res) => res.json({ name: config.userName }));

  // Nobody is called 'them'; it is what a conversation says until a name is typed or heard.
  const cleanName = raw => (typeof raw === 'string' ? raw.trim().slice(0, 80) : '') || 'them';

  app.post('/api/conversations', (req, res) => {
    const { tag, otherName, consentConfirmed } = req.body ?? {};
    if (consentConfirmed !== true) return fail(res, 400, 'Confirm you told them you are recording first');
    if (!TAGS.includes(tag)) return fail(res, 400, `tag must be one of ${TAGS.join(', ')}`);
    // The name is optional: the transcript usually supplies it ("Hi Abuela", "I'm Priya").
    const convo = store.createConversation({ tag, otherName: cleanName(otherName) });
    stage.publish({ type: 'conversation', conversation: convo });
    res.status(201).json(convo);
  });

  app.get('/api/conversations', (req, res) => res.json(store.listConversations().map(flagged)));

  app.get('/api/conversations/:id', (req, res) => {
    const convo = findConvo(req, res);
    if (convo) res.json(convo);
  });

  app.post('/api/conversations/:id/user-label', (req, res) => {
    const convo = findConvo(req, res);
    if (!convo) return;
    const label = req.body?.label;
    const speakers = new Set((convo.turns ?? []).map(t => t.speaker));
    if (!speakers.has(label)) return fail(res, 400, 'That label is not in this transcript');
    const updated = store.updateConversation(convo.id, { userLabel: label });
    stage.publish({ type: 'conversation', conversation: updated });
    res.json(updated);
  });

  // One coaching run per conversation at a time: a double tap joins the run already going instead of
  // paying Muse twice and racing on the result.
  const inFlight = new Map();

  app.post('/api/conversations/:id/process', async (req, res, next) => {
    try {
      const convo = findConvo(req, res);
      if (!convo) return;
      if (inFlight.has(convo.id)) return res.json(await inFlight.get(convo.id));
      // Labelling only means something when diarization actually told two voices apart.
      const voices = new Set((convo.turns ?? []).map(t => t.speaker).filter(s => s && s !== 'unknown')).size;
      if ((convo.turns ?? []).length >= 2 && voices >= 2 && !convo.userLabel) return fail(res, 400, 'Tap one of your own lines first');
      const reflection = typeof req.body?.reflection === 'string' ? req.body.reflection.slice(0, 2000) : '';
      stage.publish({ type: 'processing', conversationId: convo.id });
      const run = processConversation({ store, llm, log, id: convo.id, reflection });
      inFlight.set(convo.id, run);
      let done;
      try {
        done = await run;
      } catch (err) {
        // Give the screens a terminal message instead of leaving them on a spinner.
        stage.publish({ type: 'processing', conversationId: convo.id, failed: true });
        throw err;
      } finally {
        inFlight.delete(convo.id);
      }
      stage.publish({ type: 'conversation', conversation: done });
      stage.publish({ type: 'memory' });
      res.json(done);
    } catch (err) { next(err); }
  });

  app.patch('/api/conversations/:id', async (req, res, next) => {
    try {
      let convo = findConvo(req, res);
      if (!convo) return;
      const { tag, otherName } = req.body ?? {};
      // Correcting (or adding) the name is a plain rename: nothing to recoach.
      if (otherName !== undefined) {
        if (typeof otherName !== 'string') return fail(res, 400, 'otherName must be text');
        convo = store.updateConversation(convo.id, { otherName: cleanName(otherName) });
        stage.publish({ type: 'conversation', conversation: convo });
        if (tag === undefined) return res.json(convo);
      }
      if (!TAGS.includes(tag)) return fail(res, 400, `tag must be one of ${TAGS.join(', ')}`);
      if (inFlight.has(convo.id)) return fail(res, 409, 'Coaching is still running; change the tag when it finishes');
      stage.publish({ type: 'processing', conversationId: convo.id });
      let done;
      try {
        done = await recoach({ store, llm, log, id: convo.id, tag });
      } catch (err) {
        stage.publish({ type: 'processing', conversationId: convo.id, failed: true });
        throw err;
      }
      stage.publish({ type: 'conversation', conversation: done });
      stage.publish({ type: 'memory' });
      res.json(done);
    } catch (err) { next(err); }
  });

  app.delete('/api/conversations/:id', async (req, res, next) => {
    try {
      if (!store.deleteConversation(req.params.id)) return fail(res, 404, 'Conversation not found');
      removeMedia(req.params.id);
      log('privacy', 'info', `deleted conversation ${req.params.id.slice(0, 8)} with its signals, note and video`);
      await refreshMemory({ store, llm, log });
      stage.publish({ type: 'deleted', conversationId: req.params.id });
      stage.publish({ type: 'memory' });
      res.status(204).end();
    } catch (err) { next(err); }
  });

  app.get('/api/conversations/:id/compare', (req, res) => {
    const convo = findConvo(req, res);
    if (!convo) return;
    if (!coachable(convo)) return res.json(compareConversations(null, convo));
    const previous = previousFor(store, convo);
    res.json({ ...compareConversations(previous, convo), samePerson: !!previous && samePerson(previous.otherName, convo.otherName) });
  });

  app.post('/api/conversations/:id/follow-up', async (req, res, next) => {
    try {
      const convo = findConvo(req, res);
      if (!convo) return;
      const { text, regenerate } = req.body ?? {};
      let followUp;
      if (typeof text === 'string') {
        if (!text.trim()) return fail(res, 400, 'Message is empty');
        const edited = text.trim().slice(0, 1000);
        followUp = { ...(convo.followUp ?? { status: 'draft', sentAt: null }), text: edited, hooksUsed: groundedIn(edited, convo.hooks), source: 'edited' };
        if (convo.followUp?.text !== edited) followUp = { ...followUp, status: 'draft', sentAt: null };
      } else if (convo.followUp && !regenerate) {
        return res.json(convo.followUp);
      } else {
        if (!convo.hooks) return fail(res, 400, 'Get coaching first');
        followUp = await writeFollowUp({ llm, log, convo });
      }
      const updated = store.updateConversation(convo.id, { followUp });
      stage.publish({ type: 'conversation', conversation: updated });
      res.json(updated.followUp);
    } catch (err) { next(err); }
  });

  app.post('/api/conversations/:id/follow-up/sent', (req, res) => {
    const convo = findConvo(req, res);
    if (!convo) return;
    if (!convo.followUp) return fail(res, 400, 'No follow-up to send');
    // Whatever the phone actually shared wins over the last saved draft.
    const shared = typeof req.body?.text === 'string' && req.body.text.trim() ? req.body.text.trim().slice(0, 1000) : convo.followUp.text;
    const updated = store.updateConversation(convo.id, { followUp: { ...convo.followUp, text: shared, status: 'sent', sentAt: new Date().toISOString() } });
    log('followUp', 'info', `sent to ${convo.otherName}`);
    stage.publish({ type: 'conversation', conversation: updated });
    res.json(updated.followUp);
  });

  app.get('/api/brief', (req, res) => {
    const name = typeof req.query.name === 'string' ? req.query.name.trim().slice(0, 80) : '';
    if (!name) return fail(res, 400, 'name is required');
    const conversations = store.listConversations().filter(c => coachable(c) && samePerson(c.otherName, name));
    // Show the name the way they typed it when they met, not however it was typed just now.
    res.json({ brief: buildBrief({ otherName: conversations.at(-1)?.otherName ?? name, conversations }) });
  });

  // ---------- video ----------

  const MAX_VIDEO = 200 * 1024 * 1024;
  const VIDEO_EXT = { 'video/mp4': 'mp4', 'video/quicktime': 'mp4', 'video/webm': 'webm' };
  const videoPath = convo => convo.recording && join(recordingsDir, `${convo.id}.${convo.recording.ext}`);
  const framesPath = id => join(recordingsDir, `${id}.frames.json`);
  // A new video replaces the old one and its face frames; the lip-lock cues came from the mic
  // and camera live, not from the file, so only a delete removes them.
  const removeVideo = id => {
    for (const ext of ['mp4', 'webm', 'frames.json']) rmSync(join(recordingsDir, `${id}.${ext}`), { force: true });
  };
  const removeMedia = id => {
    removeVideo(id);
    rmSync(join(recordingsDir, `${id}.cues.json`), { force: true });
  };

  app.post('/api/conversations/:id/recording', async (req, res, next) => {
    const convo = findConvo(req, res);
    if (!convo) return;
    const mime = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    const ext = VIDEO_EXT[mime];
    if (!ext) return fail(res, 415, 'Send the video as video/mp4 or video/webm');
    if (Number(req.headers['content-length']) > MAX_VIDEO) return fail(res, 413, 'Video is too large');
    mkdirSync(recordingsDir, { recursive: true });
    const tmp = join(recordingsDir, `${convo.id}.upload`);
    let bytes = 0;
    req.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > MAX_VIDEO) req.destroy(new Error('too large'));
    });
    try {
      await pump(req, createWriteStream(tmp));
    } catch (err) {
      rmSync(tmp, { force: true });
      if (bytes > MAX_VIDEO) return fail(res, 413, 'Video is too large');
      return next(err);
    }
    if (!bytes) { rmSync(tmp, { force: true }); return fail(res, 400, 'Video was empty'); }
    removeVideo(convo.id);
    renameSync(tmp, join(recordingsDir, `${convo.id}.${ext}`));
    const offsetMs = Number.isFinite(Number(req.query.offsetMs)) ? Math.round(Number(req.query.offsetMs)) : 0;
    const recording = { mime, ext, bytes, offsetMs, uploadedAt: new Date().toISOString() };
    // A new video makes old cues meaningless.
    const updated = store.updateConversation(convo.id, { recording, behavior: null, insight: null });
    log('video', 'info', `saved ${(bytes / 1e6).toFixed(1)} MB recording for ${convo.id.slice(0, 8)} (stays on this Mac)`);
    stage.publish({ type: 'conversation', conversation: updated });
    res.status(201).json(recording);
  });

  app.get('/api/conversations/:id/recording', (req, res) => {
    const convo = findConvo(req, res);
    if (!convo) return;
    const file = videoPath(convo);
    if (!file || !existsSync(file)) return fail(res, 404, 'No video for this conversation');
    // sendFile handles Range requests, which the video element needs to seek.
    res.sendFile(file, { headers: { 'Content-Type': convo.recording.mime === 'video/quicktime' ? 'video/mp4' : convo.recording.mime } });
  });

  // Background lines (lip lock) never reach the face alignment, the insight or the heatmap.
  const insightFor = convo => generateInsight({
    llm, note: convo.note, behavior: convo.behavior, hooks: convo.hooks, signals: convo.signals, turns: speechTurns(convo.turns), userLabel: convo.userLabel,
  });

  app.post('/api/conversations/:id/behavior', async (req, res, next) => {
    try {
      const convo = findConvo(req, res);
      if (!convo) return;
      // Cues analysed from a video that has since been replaced belong to nothing.
      const forVideo = req.body?.recordingUploadedAt;
      if (forVideo && convo.recording && forVideo !== convo.recording.uploadedAt) return fail(res, 409, 'The video changed; analyse it again');
      const frames = cleanFrames(req.body?.frames);
      if (!frames.length) return fail(res, 400, 'No frames');

      // Nobody said which voice is theirs: the video usually can. Without it, every line would be
      // read as the other person's and the advice would be about the wrong person.
      let labeled = convo;
      // The lip lock often names the voice at the end of the recording, and then nobody taps
      // "get coaching" on the phone: the hooks never get extracted and the timeline sits empty.
      let unprocessed = !convo.hooks && (convo.turns ?? []).length > 0;
      if (!convo.userLabel && (convo.turns ?? []).length >= 2) {
        const guess = inferUserLabel(convo.turns, frames);
        if (!guess) return res.status(409).json({ error: 'Which voice is yours? Tap one of your lines.', needsLabel: true });
        log('vision', 'info', `picked your voice (${guess.label}) from the video: ${guess.evidence}`);
        store.updateConversation(convo.id, { userLabel: guess.label });
        unprocessed = true;
      }
      if (unprocessed) {
        stage.publish({ type: 'processing', conversationId: convo.id });
        labeled = await processConversation({ store, llm, log, id: convo.id, reflection: convo.reflection ?? '' });
      }

      const behavior = alignBehavior({
        model: req.body.model, fps: Number(req.body.fps), frames,
        turns: speechTurns(labeled.turns), userLabel: labeled.userLabel, signals: labeled.signals, hooks: labeled.hooks,
      });
      mkdirSync(recordingsDir, { recursive: true });
      writeFileSync(framesPath(convo.id), JSON.stringify(frames));
      log('vision', 'info', `face cues aligned: ${behavior.frameCount} frames, face in ${Math.round(behavior.faceSeenPct * 100)}%`, behavior.stats);
      let updated = store.updateConversation(convo.id, { behavior, insight: null });
      stage.publish({ type: 'conversation', conversation: updated });
      const insight = await insightFor(updated);
      // The video may have been replaced while Muse was thinking.
      if (store.getConversation(convo.id)?.recording?.uploadedAt !== updated.recording?.uploadedAt) return fail(res, 409, 'The video changed; analyse it again');
      log('insight', insight.source === 'fallback' ? 'warn' : 'info', insight.source === 'fallback' ? 'insight from the numbers alone' : 'insight written');
      updated = store.updateConversation(convo.id, { insight });
      stage.publish({ type: 'conversation', conversation: updated });
      res.json({ behavior, insight });
    } catch (err) { next(err); }
  });

  app.get('/api/conversations/:id/behavior/frames', (req, res) => {
    const convo = findConvo(req, res);
    if (!convo) return;
    const file = framesPath(convo.id);
    res.json({ frames: existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [] });
  });

  app.post('/api/conversations/:id/insight', async (req, res, next) => {
    try {
      const convo = findConvo(req, res);
      if (!convo) return;
      if (!convo.userLabel && (convo.turns ?? []).length >= 2) return res.status(409).json({ error: 'Which voice is yours? Tap one of your lines.', needsLabel: true });
      // same as /behavior: an insight with no hooks behind it would only have the face to go on
      const ready = !convo.hooks && (convo.turns ?? []).length > 0
        ? await processConversation({ store, llm, log, id: convo.id, reflection: convo.reflection ?? '' })
        : convo;
      const insight = await insightFor(ready);
      const updated = store.updateConversation(convo.id, { insight });
      stage.publish({ type: 'conversation', conversation: updated });
      res.json(insight);
    } catch (err) { next(err); }
  });

  app.get('/api/conversations/:id/heatmap', (req, res) => {
    const convo = findConvo(req, res);
    if (!convo) return;
    const file = framesPath(convo.id);
    const frames = convo.behavior && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
    res.json(buildHeatmap({ turns: speechTurns(convo.turns), userLabel: convo.userLabel, hooks: convo.hooks, signals: convo.signals, behavior: convo.behavior, frames }));
  });

  app.get('/api/memory', (req, res) => {
    const conversations = store.listConversations();
    const signalTable = conversations.filter(c => c.signals).map(c => ({
      id: c.id,
      createdAt: c.createdAt,
      tag: c.tag,
      otherName: c.otherName,
      userQuestions: c.signals.userQuestions,
      followUps: c.signals.followUps,
      otherAvgAnswerWords: c.signals.otherAvgAnswerWords,
      userTalkShare: c.signals.userTalkShare,
    }));
    res.json({ conversations: conversations.map(flagged), pattern: store.getKv('pattern'), nextStep: store.latestNextStep(), signalTable });
  });

  app.post('/api/next-step/:id', (req, res) => {
    const status = STEP_ACTIONS[req.body?.action];
    if (!status) return fail(res, 400, 'action must be accept, change or dismiss');
    const text = req.body.action === 'change' ? String(req.body.text ?? '').trim() : undefined;
    if (req.body.action === 'change' && !text) return fail(res, 400, 'Changed step needs text');
    const step = store.updateNextStep(Number(req.params.id), { status, text });
    if (!step) return fail(res, 404, 'Next step not found');
    log('nextStep', 'info', `${status}: ${step.text}`);
    stage.publish({ type: 'memory' });
    res.json(step);
  });

  app.post('/api/stage/focus', (req, res) => {
    const { view, conversationId, otherName } = req.body ?? {};
    if (!STAGE_VIEWS.includes(view)) return fail(res, 400, `view must be one of ${STAGE_VIEWS.join(', ')}`);
    stage.focus({
      view,
      conversationId: typeof conversationId === 'string' ? conversationId : null,
      otherName: typeof otherName === 'string' && otherName.trim() ? otherName.trim().slice(0, 80) : null,
    });
    res.status(204).end();
  });

  app.get('/api/logs', (req, res) => res.json(store.listLogs(100)));

  // The Mac side: Live and Replay as sections of one page.
  app.get('/mac', (req, res) => res.sendFile(resolve(publicDir, 'studio.html')));

  app.use(express.static(publicDir));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    // body-parser errors (bad JSON, too large) are the client's fault, not ours
    if (err.status >= 400 && err.status < 500) return fail(res, err.status, err.type === 'entity.too.large' ? 'Request body too large' : 'Request body was not valid JSON');
    log('server', 'error', err.message);
    fail(res, 500, 'Something went wrong on our side');
  });

  return app;
}

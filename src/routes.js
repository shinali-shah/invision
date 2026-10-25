import express from 'express';
import { TAGS } from './agents/context.js';
import { processConversation, recoach, refreshMemory } from './pipeline.js';
import { STAGE_VIEWS } from './stage.js';

const STEP_ACTIONS = { accept: 'accepted', change: 'changed', dismiss: 'dismissed' };

const noStage = { publish() {}, focus() {} };

export function createApp({ store, llm, log, config, publicDir = 'public', stage = noStage }) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  const fail = (res, status, error) => res.status(status).json({ error });

  // resolves :id or answers 404 itself
  const findConvo = (req, res) => {
    const convo = store.getConversation(req.params.id);
    if (!convo) fail(res, 404, 'Conversation not found');
    return convo;
  };

  app.get('/api/health', (req, res) => res.json({ ok: true, mock: config.mock }));

  app.post('/api/conversations', (req, res) => {
    const { tag, otherName, consentConfirmed } = req.body ?? {};
    if (consentConfirmed !== true) return fail(res, 400, 'Confirm you told them you are recording first');
    if (!TAGS.includes(tag)) return fail(res, 400, `tag must be one of ${TAGS.join(', ')}`);
    const name = typeof otherName === 'string' ? otherName.trim().slice(0, 80) : '';
    const convo = store.createConversation({ tag, otherName: name || 'them' });
    stage.publish({ type: 'conversation', conversation: convo });
    res.status(201).json(convo);
  });

  app.get('/api/conversations', (req, res) => res.json(store.listConversations()));

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

  app.post('/api/conversations/:id/process', async (req, res, next) => {
    try {
      const convo = findConvo(req, res);
      if (!convo) return;
      if ((convo.turns ?? []).length >= 2 && !convo.userLabel) return fail(res, 400, 'Tap one of your own lines first');
      const reflection = typeof req.body?.reflection === 'string' ? req.body.reflection.slice(0, 2000) : '';
      stage.publish({ type: 'processing', conversationId: convo.id });
      const done = await processConversation({ store, llm, log, id: convo.id, reflection });
      stage.publish({ type: 'conversation', conversation: done });
      stage.publish({ type: 'memory' });
      res.json(done);
    } catch (err) { next(err); }
  });

  app.patch('/api/conversations/:id', async (req, res, next) => {
    try {
      const convo = findConvo(req, res);
      if (!convo) return;
      const { tag } = req.body ?? {};
      if (!TAGS.includes(tag)) return fail(res, 400, `tag must be one of ${TAGS.join(', ')}`);
      stage.publish({ type: 'processing', conversationId: convo.id });
      const done = await recoach({ store, llm, log, id: convo.id, tag });
      stage.publish({ type: 'conversation', conversation: done });
      stage.publish({ type: 'memory' });
      res.json(done);
    } catch (err) { next(err); }
  });

  app.delete('/api/conversations/:id', async (req, res, next) => {
    try {
      if (!store.deleteConversation(req.params.id)) return fail(res, 404, 'Conversation not found');
      log('privacy', 'info', `deleted conversation ${req.params.id.slice(0, 8)} with its signals and note`);
      await refreshMemory({ store, llm, log });
      stage.publish({ type: 'deleted', conversationId: req.params.id });
      stage.publish({ type: 'memory' });
      res.status(204).end();
    } catch (err) { next(err); }
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
    res.json({ conversations, pattern: store.getKv('pattern'), nextStep: store.latestNextStep(), signalTable });
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
    const { view, conversationId } = req.body ?? {};
    if (!STAGE_VIEWS.includes(view)) return fail(res, 400, `view must be one of ${STAGE_VIEWS.join(', ')}`);
    stage.focus({ view, conversationId: typeof conversationId === 'string' ? conversationId : null });
    res.status(204).end();
  });

  app.get('/api/logs', (req, res) => res.json(store.listLogs(100)));

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

import { api, transcribeSocketUrl } from './api.js';
import { createResampler, micErrorMessage, isCameraError, pickRecorderMime, createLeveler, rmsOf, toDb } from './mic.js';
import { startLipLock } from './lips.js';

// Spec copy, verbatim. Mirrors src/agents/context.js TAG_FOCUS.
const TAG_FOCUS = {
  family: 'Phrases to keep the conversation going, cultural context for what they said, a vocab list from words that came up',
  friend: 'Follow-up questions, remembering what matters to them, following through',
  networking: 'Clear questions, listening before pitching, a drafted follow-up message',
};
const TAG_NAMES = { family: 'Family', friend: 'Friend', networking: 'Networking' };

// Kind -> [glyph, label] for the pre-meeting brief, in the order the server sorts them.
const BRIEF_KINDS = {
  commitment: ['↩', 'Follow through'],
  event: ['◷', 'Ask how it went'],
  topic: ['#', 'Bring up'],
  suggestion: ['◦', 'Try'],
};
const BRIEF_DEBOUNCE_MS = 400;

const FRAME_SAMPLES = 1920; // 80 ms at 24 kHz = 3840 bytes
const DONE_TIMEOUT_MS = 20000;

const AUDIO_CONSTRAINTS = { echoCancellation: false, noiseSuppression: false, autoGainControl: true };
const VIDEO_CONSTRAINTS = {
  facingMode: 'environment',
  width: { ideal: 640 },
  height: { ideal: 480 },
  frameRate: { ideal: 15, max: 15 },
};
const CAN_RECORD_VIDEO = !!navigator.mediaDevices && typeof window.MediaRecorder === 'function';

const $ = (id) => document.getElementById(id);

const state = {
  convo: null,          // the Conversation we're working on
  liveTurns: new Map(), // turnId -> { speaker, text, partial }
  rec: null,            // active recording handles
  uploads: new Map(),   // conversationId -> { blob, offsetMs, status, pct, error, recording }
};

// ---------- small helpers ----------

function showView(name) {
  for (const v of document.querySelectorAll('.view')) v.hidden = v.id !== `view-${name}`;
  window.scrollTo(0, 0);
  // Start and memory aren't about one conversation, even if state.convo still
  // holds the last one we looked at.
  const convoId = name === 'start' || name === 'memory' ? null : state.convo?.id ?? null;
  api.stageFocus(name, convoId);
}

// True while this conversation is still the one on screen in that view, so a
// slow response doesn't yank the user back after they've moved on.
function stillOn(view, id) {
  return !$(`view-${view}`).hidden && state.convo && state.convo.id === id;
}

function showError(id, err) {
  const el = $(id);
  if (!err) { el.hidden = true; el.textContent = ''; return; }
  el.textContent = typeof err === 'string' ? err : err.message;
  el.hidden = false;
}

function el(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids) if (kid != null) node.append(kid);
  return node;
}

// replaceChildren prints a stray null as the text "null"; this skips the optional bits.
function put(node, ...kids) {
  node.replaceChildren(...kids.filter((k) => k != null && k !== false));
}

function checkedTag(name) {
  const input = document.querySelector(`input[name="${name}"]:checked`);
  return input ? input.value : 'family';
}

function setCheckedTag(name, tag) {
  for (const input of document.querySelectorAll(`input[name="${name}"]`)) input.checked = input.value === tag;
}

function fmtDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function fmtNum(v, suffix = '') {
  return v === null || v === undefined || Number.isNaN(v) ? '—' : `${v}${suffix}`;
}

function talkSharePct(share) {
  return share === null || share === undefined ? null : Math.round(share * 100);
}

// A line the lip lock put down to the crowd: greyed, tagged, kept.
const isCrowd = (t) => t.source === 'crowd';
const crowdTag = () => el('span', { class: 'bg-tag', text: 'Background' });

// Distinct real speaker labels in first-seen order. Crowd lines carry Muse letters too, but
// those aren't voices in the conversation: one would cost the other person their name and
// pad out "N voices heard".
function speakerLabels(turns) {
  const seen = [];
  for (const t of turns) if (t.speaker !== 'unknown' && !isCrowd(t) && !seen.includes(t.speaker)) seen.push(t.speaker);
  return seen;
}

// Before the user picks: "Speaker A". After: "You" for their label, and the
// typed name for the other label when there's exactly one other voice.
function speakerName(speaker, convo, labels) {
  if (speaker === 'unknown' || !speaker) return 'Unclear speaker';
  const userLabel = convo && convo.userLabel;
  if (!userLabel) return `Speaker ${speaker}`;
  if (speaker === userLabel) return 'You';
  const others = labels.filter((l) => l !== userLabel);
  if (others.length === 1 && isNamed(convo)) return convo.otherName;
  return `Speaker ${speaker}`;
}

function lineClass(speaker, convo, labels) {
  const userLabel = convo && convo.userLabel;
  if (speaker === 'unknown') return 'line';
  if (userLabel) return speaker === userLabel ? 'line is-you' : 'line is-them';
  const idx = labels.indexOf(speaker);
  return idx === 0 || idx === 1 ? `line spk-${idx}` : 'line';
}

function renderTranscript(listId, turns, convo, { pickable = false, cited = [], onPick } = {}) {
  const list = $(listId);
  list.replaceChildren();
  const labels = speakerLabels(turns);
  for (const t of turns) {
    const cls = lineClass(t.speaker, convo, labels) + (cited.includes(t.turnId) ? ' cited' : '') + (isCrowd(t) ? ' is-crowd' : '');
    // A crowd line stays "Speaker X": it isn't you, and the Background tag already says it isn't them.
    const whoText = isCrowd(t) && t.speaker && t.speaker !== 'unknown' ? `Speaker ${t.speaker}` : speakerName(t.speaker, convo, labels);
    const who = el('span', { class: 'who', text: whoText });
    const said = el('span', { class: 'said', text: t.text }, isCrowd(t) ? crowdTag() : null);
    if (pickable) {
      const btn = el('button', {
        type: 'button',
        disabled: t.speaker === 'unknown',
        onclick: () => onPick(t.speaker),
      }, who, said);
      list.append(el('li', { class: cls }, btn));
    } else {
      list.append(el('li', { class: cls, 'data-turn': t.turnId }, who, said));
    }
  }
}

// The note quotes the transcript back at you. Those bits were actually said, so
// they get the speech face; the rest is the coach talking.
function withSpeech(text) {
  return String(text || '').split(/(“[^”]*”|"[^"]*")/).filter(Boolean)
    .map((part) => (/^[“"]/.test(part) ? el('span', { class: 'q', text: part }) : document.createTextNode(part)));
}

// ---------- start view ----------

function updateFocus() {
  $('tag-focus').textContent = TAG_FOCUS[checkedTag('tag-start')];
}

function updateCamera() {
  const on = $('camera').checked;
  $('camera-hint').hidden = !on;
  $('consent-text').textContent = on ? "I told them I'm recording audio and video" : "I told them I'm recording";
}

function updateRecordEnabled() {
  const ok = $('consent').checked;
  $('record-btn').disabled = !ok;
  $('record-hint').textContent = ok
    ? 'Tap to start. Tap again to stop.'
    : 'Tick the box once they know, then tap to start.';
}

// The name field is tucked away: the transcript usually supplies the name ("Hi Abuela!").
function showNameField(show) {
  $('other-name-field').hidden = !show;
  $('who-pickup').hidden = show;
  if (show) $('other-name').focus({ preventScroll: true });
}

function resetStart() {
  $('other-name').value = '';
  showNameField(false);
  clearTimeout(briefTimer);
  briefSeq += 1;
  renderBrief(null);
  $('consent').checked = false;
  setCheckedTag('tag-start', 'family');
  updateFocus();
  updateCamera();
  updateRecordEnabled();
  showError('start-error', null);
  showView('start');
  refreshFinishBanner();
}

// ---------- finish coaching banner ----------

// Recordings left on the label step (phone put down right after Stop) have no coaching yet.
// The server flags them needsLabel; start and memory carry the way back until a line is tapped.
let unfinished = [];

async function refreshFinishBanner() {
  try {
    const mem = await api.memory();
    unfinished = (mem.conversations || []).filter((c) => c.needsLabel);
  } catch { /* keep whatever we last knew */ }
  renderFinishBanner();
}

function renderFinishBanner() {
  const rows = [...unfinished].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  for (const id of ['finish-banner-start', 'finish-banner-memory']) {
    const box = $(id);
    box.hidden = !rows.length;
    box.replaceChildren(...rows.map((c) => el('div', { class: 'finish-row' },
      el('span', { class: 'finish-dot', 'aria-hidden': 'true' }),
      el('span', { class: 'finish-text' },
        el('strong', { text: isNamed(c) ? `Finish coaching for ${c.otherName}` : 'Finish coaching' }),
        document.createTextNode(': tap which voice is yours'),
      ),
      el('button', { type: 'button', class: 'finish-btn', text: 'Finish', onclick: () => openConversation(c) }),
    )));
  }
}

// ---------- pre-meeting brief ----------

let briefTimer = null;
let briefSeq = 0;

function onNameInput() {
  clearTimeout(briefTimer);
  briefTimer = setTimeout(loadBrief, BRIEF_DEBOUNCE_MS);
}

async function loadBrief() {
  const name = $('other-name').value.trim();
  const seq = ++briefSeq;
  const asked = name.length >= 2 ? name : null;
  if ($('view-start').hidden) return;
  api.stageFocus('start', null, asked);
  if (!asked) { renderBrief(null); return; }
  let brief = null;
  try {
    const data = await api.getBrief(asked);
    brief = data && data.brief;
  } catch { /* no brief is fine; it's a bonus */ }
  // Typed more since, or already recording.
  if (seq !== briefSeq || $('view-start').hidden) return;
  renderBrief(brief);
}

// Server text sometimes starts with the same words as our label ("Follow through: …").
function stripLead(text, label) {
  const t = String(text || '');
  if (!t.toLowerCase().startsWith(`${label.toLowerCase()}:`)) return t;
  const rest = t.slice(label.length + 1).trim();
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

// Same card on the start view ("Before you talk to Abuela") and, once the name is heard, on the
// ticket mid-conversation ("Before you go on").
function renderBrief(brief, { card = $('brief-card'), title = null } = {}) {
  const items = brief && Array.isArray(brief.items) ? brief.items : [];
  if (!items.length) { card.hidden = true; card.replaceChildren(); return; }
  const meta = [
    brief.lastMetAt ? `Last talked ${fmtDate(brief.lastMetAt)}` : null,
    brief.conversations ? `${brief.conversations} conversation${brief.conversations === 1 ? '' : 's'}` : null,
  ].filter(Boolean).join(', ');
  put(card,
    el('h2', { class: 'subtitle', id: `${card.id}-title`, text: title || (isNamed(brief) ? `Before you talk to ${brief.otherName}` : 'Before you talk') }),
    meta ? el('p', { class: 'card-meta', text: meta }) : null,
    el('ul', { class: 'brief-items' }, ...items.map((it) => {
      const [glyph, label] = BRIEF_KINDS[it.kind] || ['•', 'Note'];
      return el('li', { class: `brief-item kind-${it.kind}` },
        el('span', { class: 'brief-glyph', 'aria-hidden': 'true', text: glyph }),
        el('span', { class: 'brief-label', text: label }),
        el('span', { class: 'brief-text', text: stripLead(it.text, label) }),
      );
    })),
  );
  card.hidden = false;
}

// ---------- recording ----------

async function startRecording() {
  const btn = $('record-btn');
  if (btn.getAttribute('aria-busy') === 'true') return;
  showError('start-error', null);

  // iOS only lets an AudioContext run if it's created/resumed inside the tap.
  // Do this before any await.
  let ctx;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC();
    ctx.resume().catch(() => {});
  } catch (err) {
    showError('start-error', micErrorMessage(err, { isSecureContext: window.isSecureContext }));
    return;
  }

  btn.setAttribute('aria-busy', 'true');
  const wantVideo = $('camera').checked && CAN_RECORD_VIDEO;
  let stream = null;
  let videoNote = null;
  try {
    if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('getUserMedia unavailable');
    }
    if (wantVideo) {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: AUDIO_CONSTRAINTS, video: VIDEO_CONSTRAINTS });
      } catch (err) {
        // The camera is optional. Anything camera-shaped drops us to audio only;
        // if the mic is the problem the audio-only call below fails and says so.
        if (!isCameraError(err)) throw err;
        videoNote = err.name === 'NotAllowedError'
          ? 'Camera was blocked, so this one is audio only.'
          : 'No camera available, so this one is audio only.';
      }
    }
    if (!stream) stream = await navigator.mediaDevices.getUserMedia({ audio: AUDIO_CONSTRAINTS });
  } catch (err) {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    ctx.close().catch(() => {});
    btn.removeAttribute('aria-busy');
    showError('start-error', micErrorMessage(err, { isSecureContext: window.isSecureContext }));
    return;
  }
  // The worklet is fetched from the server, so with the mic already live the only way this fails
  // is the server being unreachable. That's not a microphone problem and shouldn't read like one.
  try {
    await ctx.audioWorklet.addModule('pcm-worklet.js');
  } catch {
    stream.getTracks().forEach((t) => t.stop());
    ctx.close().catch(() => {});
    btn.removeAttribute('aria-busy');
    showError('start-error', "Couldn't reach the server. Check the connection and try again.");
    return;
  }

  let convo;
  try {
    convo = await api.createConversation({
      tag: checkedTag('tag-start'),
      otherName: $('other-name').value.trim(),
    });
  } catch (err) {
    stream.getTracks().forEach((t) => t.stop());
    ctx.close().catch(() => {});
    btn.removeAttribute('aria-busy');
    showError('start-error', err);
    return;
  }
  btn.removeAttribute('aria-busy');

  state.convo = convo;
  state.liveTurns = new Map();
  beginCapture(convo, ctx, stream, videoNote);
}

function beginCapture(convo, ctx, stream, videoNote = null) {
  const ws = new WebSocket(transcribeSocketUrl(convo.id));
  ws.binaryType = 'arraybuffer';

  const rec = {
    ctx, stream, ws,
    frame: new Int16Array(FRAME_SAMPLES),
    frameLen: 0,
    queue: [],          // frames captured before the socket opened
    startedAt: Date.now(),
    timer: null,
    stopping: false,
    finished: false,
    resolveDone: null,
    turns: [],
    lastError: null,    // server's own words, so the label view can repeat them
    resample: createResampler(ctx.sampleRate),
    firstAudioAt: null, // transcript time 0
    recorder: null,
    chunks: [],
    videoAt: null,      // video time 0, from the recorder's start event
    lips: null,         // lip lock, while the camera is on
  };
  state.rec = rec;

  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'pcm-capture');
  // Safari won't pull audio through a node that isn't connected to the output,
  // so route it into a muted gain.
  const mute = ctx.createGain();
  mute.gain.value = 0;
  // mic → mono → auto level → limiter → (transcription, and the video's soundtrack)
  const level = buildLevelChain(ctx, source, (db, levelDb) => rec.lips && rec.lips.level(db, levelDb));
  level.out.connect(node);
  node.connect(mute);
  mute.connect(ctx.destination);
  rec.node = node;
  rec.source = source;
  rec.level = level;
  // The recorder gets the levelled mono track instead of the raw quiet one.
  rec.recordStream = new MediaStream([...stream.getVideoTracks(), ...level.dest.stream.getAudioTracks()]);

  node.port.onmessage = (e) => {
    if (rec.stopping) return;
    // Transcript 0 is this chunk's first sample, which was captured a whole chunk before it got here.
    if (rec.firstAudioAt === null) rec.firstAudioAt = Date.now() - (e.data.length / ctx.sampleRate) * 1000;
    pushSamples(rec, rec.resample(e.data));
  };

  // iOS suspends the context on screen lock, a phone call or Siri, and the
  // mic just goes quiet. Try to pick back up and say so instead of failing silently.
  ctx.onstatechange = () => {
    if (rec.stopping || ctx.state === 'running' || ctx.state === 'closed') return;
    showError('rec-error', 'Audio paused (screen lock or a call?). Keep the screen on. Trying to resume…');
    ctx.resume().then(() => {
      if (!rec.stopping && ctx.state === 'running') showError('rec-error', null);
    }).catch(() => {});
  };
  // The permission sheet on first use can leave the context suspended even
  // though we resumed it in the tap. Once the mic is live iOS lets us resume.
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});

  ws.onopen = () => {
    for (const f of rec.queue) ws.send(f);
    rec.queue = [];
  };
  ws.onmessage = (e) => {
    if (typeof e.data !== 'string') return;
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    handleSocketMessage(rec, msg);
  };
  ws.onerror = () => {
    showError('rec-error', 'Lost the connection to the transcriber. Whatever was heard so far is kept.');
  };
  ws.onclose = () => {
    if (!rec.finished) finishRecording(rec, rec.turns.length ? rec.turns : liveTurnsAsList());
  };

  // UI
  // Reads the way the Figma ticket does: "Session with Maya"
  $('rec-with').textContent = convo.otherName && convo.otherName !== 'them'
    ? `Session with ${convo.otherName}`
    : `${TAG_NAMES[convo.tag]} session`;
  $('rec-timer').textContent = '0:00';
  $('live-transcript').replaceChildren();
  $('live-transcript').dataset.empty = 'Listening…';
  showError('rec-error', null);
  if (stream.getVideoTracks().length && !startVideo(rec)) {
    videoNote = 'This browser can’t record video, so this one is audio only.';
  }
  if (rec.recorder) startLips(rec);
  $('rec-note').textContent = videoNote || '';
  $('rec-note').hidden = !videoNote;
  $('stop-btn').disabled = false;
  $('stop-btn').querySelector('.disc-label').textContent = 'Stop';
  rec.timer = setInterval(() => {
    const s = Math.floor((Date.now() - rec.startedAt) / 1000);
    // Colon in its own span so it can skip tabular width; the digits keep it and don't jitter.
    $('rec-timer').replaceChildren(String(Math.floor(s / 60)), el('span', { class: 'colon', text: ':' }), String(s % 60).padStart(2, '0'));
  }, 500);
  showView('recording');
  // A typed name is known from the first second; a heard one arrives as a `person` message.
  $('person-edit').hidden = true;
  $('rec-person').hidden = true;
  renderBrief(null, { card: $('rec-brief') });
  if (isNamed(convo)) setPerson(convo.otherName);
}

// ---------- who they are ----------

const isNamed = (convo) => !!(convo && convo.otherName && convo.otherName !== 'them');

let recBriefSeq = 0;

// The name landed (heard in the transcript, typed, or corrected): chip, headline, stage, brief.
function setPerson(name) {
  state.convo = { ...state.convo, otherName: name };
  const chip = $('rec-person');
  chip.textContent = `With ${name}`;
  chip.hidden = false;
  $('person-edit').hidden = true;
  $('rec-with').textContent = `Session with ${name}`;
  if (state.rec) api.stageFocus('recording', state.convo.id, name);
  loadRecBrief(name);
}

async function loadRecBrief(name) {
  const id = state.convo.id;
  const seq = ++recBriefSeq;
  let brief = null;
  try {
    const data = await api.getBrief(name);
    brief = data && data.brief;
  } catch { /* the brief is a bonus */ }
  // Renamed since, or already stopped.
  if (seq !== recBriefSeq || !state.rec || state.convo.id !== id) return;
  renderBrief(brief, { card: $('rec-brief'), title: 'Before you go on' });
}

function onPersonHeard(msg) {
  if (typeof msg.name !== 'string' || !msg.name.trim()) return;
  // The server only says this while the conversation is still 'them', but a correction typed
  // on the phone in the same moment wins.
  if (isNamed(state.convo) && state.convo.otherName !== msg.name) return;
  setPerson(msg.name);
}

// Tap the chip, fix the name in place. Submitting it empty just puts the chip back.
function startNameEdit() {
  const form = $('person-edit');
  const input = $('person-input');
  input.value = isNamed(state.convo) ? state.convo.otherName : '';
  $('rec-person').hidden = true;
  form.hidden = false;
  input.focus({ preventScroll: true });
  input.select();
}

function cancelNameEdit() {
  $('person-edit').hidden = true;
  $('rec-person').hidden = !isNamed(state.convo);
}

async function saveNameEdit(e) {
  e.preventDefault();
  const name = $('person-input').value.trim();
  if (!name || !state.convo) return cancelNameEdit();
  const id = state.convo.id;
  const save = $('person-edit').querySelector('button');
  save.disabled = true;
  try {
    const updated = await api.setOtherName(id, name);
    if (!state.convo || state.convo.id !== id) return;
    setPerson(updated.otherName);
  } catch (err) {
    showError('rec-error', err);
    cancelNameEdit();
  } finally {
    save.disabled = false;
  }
}

// On the label view: "With Abuela · Change", or "Who was this? Add a name" when nothing was heard.
function renderLabelWho() {
  const box = $('label-who');
  const convo = state.convo;
  const id = convo.id;
  const named = isNamed(convo);
  const edit = () => {
    const input = el('input', { type: 'text', placeholder: 'Their name', 'aria-label': 'Their name', autocapitalize: 'words', maxlength: 60, enterkeyhint: 'done' });
    input.value = named ? convo.otherName : '';
    const save = el('button', { type: 'button', class: 'person-save', text: 'Save' });
    const submit = async () => {
      const name = input.value.trim();
      if (!name) return renderLabelWho();
      save.disabled = true;
      try {
        const updated = await api.setOtherName(id, name);
        if (!stillOn('label', id)) return;
        state.convo = { ...state.convo, otherName: updated.otherName };
        showLabelView();
      } catch (err) {
        save.disabled = false;
        showError('label-error', err);
      }
    };
    save.addEventListener('click', submit);
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); submit(); }
      if (ev.key === 'Escape') renderLabelWho();
    });
    box.replaceChildren(input, save);
    input.focus({ preventScroll: true });
  };
  box.replaceChildren(
    named ? el('span', {}, 'With ', el('strong', { text: convo.otherName })) : el('span', { text: 'Who was this?' }),
    el('button', { type: 'button', class: 'inline-link', text: named ? 'Change' : 'Add a name', onclick: edit }),
  );
  box.hidden = false;
}

// ---------- video ----------

// Some mics show up as stereo with the voice on one side only, and with the phone's own voice
// processing off they can sit ~30 dB under normal speech. Fold to mono, then level it.
function buildLevelChain(ctx, source, onLevel = null) {
  const mono = ctx.createGain();
  mono.channelCount = 1;
  mono.channelCountMode = 'explicit';
  mono.channelInterpretation = 'speakers';
  const gain = ctx.createGain();
  // Head start until the first words are measured. The leveler jumps to the right gain on its
  // first reading anyway; anything bigger than this drives a normal mic into clipping for the ~1 s
  // the gain takes to ramp back down.
  gain.gain.value = 2;
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -6;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.15;
  const meter = ctx.createAnalyser();
  meter.fftSize = 2048;
  const dest = ctx.createMediaStreamDestination();
  dest.channelCount = 1;

  source.connect(mono);
  mono.connect(meter);
  mono.connect(gain);
  gain.connect(limiter);
  limiter.connect(dest);

  const leveler = createLeveler();
  const buf = new Float32Array(meter.fftSize);
  const timer = setInterval(() => {
    meter.getFloatTimeDomainData(buf);
    const rms = rmsOf(buf);
    const g = leveler(rms);
    if (g != null) gain.gain.setTargetAtTime(g, ctx.currentTime, 0.4);
    // The meter sits before the gain, so this is the mic as heard: the lip lock compares it with
    // the speech level the leveler is tracking.
    if (onLevel) onLevel(toDb(rms), leveler.levelDb);
  }, 100);

  return {
    out: limiter,
    dest,
    stop() {
      clearInterval(timer);
      try { source.disconnect(mono); } catch { /* already gone */ }
    },
  };
}

// Returns false if there's no usable MediaRecorder; the camera is turned off then.
function startVideo(rec) {
  const stream = rec.recordStream || rec.stream;
  const mimeType = pickRecorderMime((m) => MediaRecorder.isTypeSupported(m));
  let recorder;
  try {
    recorder = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), videoBitsPerSecond: 1_000_000 });
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) rec.chunks.push(e.data); };
    // The recording's clock starts when start() is called, not when the start event fires;
    // in Chrome that event lands ~60 ms later, after the encoders have spun up.
    rec.videoAt = Date.now();
    recorder.start(1000);
  } catch {
    rec.stream.getVideoTracks().forEach((t) => { t.stop(); rec.stream.removeTrack(t); });
    return false;
  }
  rec.recorder = recorder;
  // Video only, so the preview never touches the audio session.
  const preview = $('rec-preview');
  preview.srcObject = new MediaStream(stream.getVideoTracks());
  preview.hidden = false;
  preview.play().catch(() => {});
  return true;
}

function hidePreview() {
  const preview = $('rec-preview');
  preview.hidden = true;
  preview.srcObject = null;
  $('lip-pill').hidden = true;
  $('lip-reticle').hidden = true;
}

// ---------- lip lock ----------

const LIP_COPY = { tracking: 'Lip lock', locked: 'Lip lock', lost: 'Point at them', off: 'Lip lock off' };

function startLips(rec) {
  const pill = $('lip-pill');
  pill.textContent = 'Lip lock';
  pill.className = 'rec-tag lip-tag';
  pill.hidden = false;
  rec.lips = startLipLock({
    video: $('rec-preview'),
    timeBase: () => rec.firstAudioAt,
    send: (samples) => {
      // Same treatment as the audio frames: a batch from before the socket opened waits in the
      // queue (ws.send takes strings and buffers alike), so the first seconds of cues aren't lost
      // when a cached model comes up before a slow tunnel does.
      const msg = JSON.stringify({ type: 'cues', samples });
      if (rec.ws.readyState === WebSocket.OPEN) rec.ws.send(msg);
      else if (rec.ws.readyState === WebSocket.CONNECTING) rec.queue.push(msg);
      else return;
      rec.cuesSent = true; // fallback for the label step's copy when the server doesn't say where the label came from
    },
    onState: renderLipState,
  });
}

function stopLips(rec) {
  if (!rec.lips) return;
  rec.lips.stop();
  rec.lips = null;
}

function renderLipState({ status, box }) {
  const pill = $('lip-pill');
  pill.textContent = LIP_COPY[status] || 'Lip lock';
  pill.className = `rec-tag lip-tag ${status}`;
  const ret = $('lip-reticle');
  const video = $('rec-preview');
  if (!box || status === 'off' || video.hidden || !video.videoWidth) { ret.hidden = true; return; }
  // The preview crops the frame (object-fit: cover), so map through the same scale and offset.
  const ew = video.clientWidth, eh = video.clientHeight;
  const scale = Math.max(ew / video.videoWidth, eh / video.videoHeight);
  const ox = (ew - video.videoWidth * scale) / 2;
  const oy = (eh - video.videoHeight * scale) / 2;
  const pad = 0.04; // a little air around the lips
  const x = (box.x - pad) * video.videoWidth * scale + ox;
  const y = (box.y - pad) * video.videoHeight * scale + oy;
  const w = (box.w + pad * 2) * video.videoWidth * scale;
  const h = (box.h + pad * 2) * video.videoHeight * scale;
  ret.style.left = `${Math.max(0, x)}px`;
  ret.style.top = `${Math.max(0, y)}px`;
  ret.style.width = `${Math.min(w, ew - Math.max(0, x))}px`;
  ret.style.height = `${Math.min(h, eh - Math.max(0, y))}px`;
  ret.className = `lip-reticle${status === 'locked' ? ' locked' : ''}`;
  ret.hidden = false;
}

// keep = upload what we got; otherwise throw it away. Call before the tracks
// are stopped so the recorder flushes its last chunk cleanly.
function endVideo(rec, keep) {
  stopLips(rec);
  hidePreview();
  // Walking out after Stop: the recorder was already told to stop and its flush is still on its
  // way. Without this it would upload the video to a conversation we've just deleted and keep
  // the blob around for good.
  if (!keep) rec.discard = true;
  const recorder = rec.recorder;
  if (!recorder) return;
  rec.recorder = null;
  const id = state.convo && state.convo.id;
  if (keep && id) {
    const flush = () => {
      if (rec.discard) { rec.chunks = []; return; }
      const blob = new Blob(rec.chunks, { type: recorder.mimeType || rec.chunks[0]?.type || 'video/mp4' });
      rec.chunks = [];
      if (!blob.size) return;
      // Video time of transcript 0. Negative if audio started before the recorder did.
      const offsetMs = (rec.firstAudioAt ?? rec.startedAt) - (rec.videoAt ?? rec.startedAt);
      state.uploads.set(id, { blob, offsetMs, status: 'uploading', pct: 0, error: null, recording: null });
      uploadVideo(id);
    };
    // If the camera or mic was taken away mid-recording (a call, the system reclaiming the camera)
    // the recorder has already stopped itself and won't fire stop again; the chunks are still here.
    if (recorder.state === 'inactive') return flush();
    recorder.onstop = flush;
  } else {
    recorder.ondataavailable = null;
    recorder.onstop = null;
    rec.chunks = [];
  }
  try { if (recorder.state !== 'inactive') recorder.stop(); } catch { /* already stopped */ }
}

async function uploadVideo(id) {
  const up = state.uploads.get(id);
  if (!up || up.status === 'done') return;
  up.status = 'uploading';
  up.pct = 0;
  up.error = null;
  renderVideo();
  try {
    up.req = api.uploadRecording(id, up.blob, up.offsetMs, (p) => {
      up.pct = Math.round(p * 100);
      renderVideo();
    });
    const recording = await up.req;
    if (state.uploads.get(id) !== up) return; // deleted meanwhile
    up.status = 'done';
    up.blob = null; // it's on the Mac now
    up.recording = recording || { offsetMs: up.offsetMs };
    if (state.convo && state.convo.id === id) state.convo = { ...state.convo, recording: up.recording };
  } catch (err) {
    if (state.uploads.get(id) !== up) return;
    up.status = 'failed';
    up.error = err.message;
  }
  renderVideo();
}

// The conversation is going away: stop sending its video too, otherwise the whole blob still
// crosses the tunnel to a 404.
function dropUpload(id) {
  const up = state.uploads.get(id);
  if (up && up.req) up.req.abort();
  state.uploads.delete(id);
}

// Upload status on the label view, plus the Replay link on coaching.
function renderVideo() {
  const convo = state.convo;
  const up = convo ? state.uploads.get(convo.id) : null;
  const status = () => {
    if (!up) return null;
    if (up.status === 'uploading') {
      return el('p', { class: 'video-line', text: `Uploading video… ${up.pct}%` });
    }
    if (up.status === 'done') return el('p', { class: 'video-line saved', text: 'Video saved' });
    return el('div', { class: 'video-failed' },
      el('p', { class: 'video-line failed', text: `Video didn’t upload. ${up.error || ''}`.trim() }),
      el('button', { type: 'button', class: 'retry-btn', text: 'Retry upload', onclick: () => uploadVideo(convo.id) }));
  };

  const label = $('label-video');
  const labelStatus = status();
  label.replaceChildren(...(labelStatus ? [labelStatus] : []));
  label.hidden = !labelStatus;

  const card = $('coach-video');
  const saved = convo && (convo.recording || (up && up.status === 'done'));
  const coachStatus = up && up.status !== 'done' ? status() : null;
  if (!saved && !coachStatus) { card.hidden = true; card.replaceChildren(); return; }
  card.replaceChildren(...[
    el('div', { class: 'card-head' },
      el('h2', { class: 'subtitle', text: 'Video' }),
      saved ? el('span', { class: 'card-meta', text: 'Video saved' }) : null),
    coachStatus,
    saved ? el('p', { class: 'hint', text: 'Open Replay on your Mac to see the video analysis.' }) : null,
    saved ? el('a', { class: 'primary replay-link', href: `/mac#replay=${encodeURIComponent(convo.id)}`, text: 'Open Replay on the Mac' }) : null,
  ].filter(Boolean));
  card.hidden = false;
}

function pushSamples(rec, samples) {
  let i = 0;
  while (i < samples.length) {
    const n = Math.min(samples.length - i, FRAME_SAMPLES - rec.frameLen);
    rec.frame.set(samples.subarray(i, i + n), rec.frameLen);
    rec.frameLen += n;
    i += n;
    if (rec.frameLen === FRAME_SAMPLES) {
      sendFrame(rec, rec.frame);
      rec.frame = new Int16Array(FRAME_SAMPLES);
      rec.frameLen = 0;
    }
  }
}

function sendFrame(rec, frame) {
  if (rec.ws.readyState === WebSocket.OPEN) rec.ws.send(frame.buffer);
  else if (rec.ws.readyState === WebSocket.CONNECTING) rec.queue.push(frame.buffer);
}

function liveTurnsAsList() {
  return [...state.liveTurns.entries()]
    .filter(([, t]) => !t.partial)
    .map(([turnId, t]) => ({ turnId, speaker: t.speaker, text: t.text, startMs: 0, endMs: 0 }));
}

function renderLive() {
  const list = $('live-transcript');
  const entries = [...state.liveTurns.entries()].sort((a, b) => a[0] - b[0]);
  const labels = speakerLabels(entries.map(([, t]) => t));
  list.replaceChildren(...entries.map(([turnId, t]) => el('li',
    { class: lineClass(t.speaker, null, labels) + (t.partial ? ' partial' : ''), 'data-turn': turnId },
    el('span', { class: 'who', text: speakerName(t.speaker, null, labels) }),
    el('span', { class: 'said', text: t.text }),
  )));
  const last = list.lastElementChild;
  if (last && last.getBoundingClientRect().bottom > window.innerHeight - 160) {
    last.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }
}

function handleSocketMessage(rec, msg) {
  switch (msg.type) {
    case 'ready':
      $('mock-badge').hidden = !msg.mock;
      break;
    case 'partial': {
      const prev = state.liveTurns.get(msg.turnId);
      if (prev && !prev.partial) break; // already final
      state.liveTurns.set(msg.turnId, {
        speaker: msg.speaker || (prev && prev.speaker) || 'unknown',
        text: msg.text || '',
        partial: true,
      });
      renderLive();
      break;
    }
    case 'turn': {
      const t = msg.turn;
      if (!t) break;
      rec.turns.push(t);
      state.liveTurns.set(t.turnId, { speaker: t.speaker, text: t.text, partial: false });
      renderLive();
      break;
    }
    case 'person':
      onPersonHeard(msg);
      break;
    case 'done':
      // A name heard in the last line arrives with done rather than ahead of it.
      if (typeof msg.otherName === 'string' && msg.otherName !== 'them' && !isNamed(state.convo)) state.convo = { ...state.convo, otherName: msg.otherName };
      finishRecording(rec, Array.isArray(msg.turns) ? msg.turns : rec.turns, {
        userLabel: typeof msg.userLabel === 'string' ? msg.userLabel : null,
        labelSource: msg.labelSource, // 'camera' | 'name' | null; undefined from a server that predates it
        crowdTurns: Number(msg.crowdTurns) || 0,
      });
      break;
    case 'error':
      rec.lastError = msg.message || 'The transcriber hit a problem. Whatever was heard so far is kept.';
      showError('rec-error', rec.lastError);
      break;
    default:
      break;
  }
}

function releaseAudio(rec) {
  if (rec.level) rec.level.stop();
  try { rec.ctx.onstatechange = null; } catch { /* ignore */ }
  try { rec.node && (rec.node.port.onmessage = null); } catch { /* ignore */ }
  try { rec.source && rec.source.disconnect(); } catch { /* ignore */ }
  rec.stream.getTracks().forEach((t) => t.stop());
  if (rec.ctx.state !== 'closed') rec.ctx.close().catch(() => {});
}

function stopRecording() {
  const rec = state.rec;
  if (!rec || rec.stopping) return;
  rec.stopping = true;
  clearInterval(rec.timer);
  const stopBtn = $('stop-btn');
  stopBtn.disabled = true;
  stopBtn.querySelector('.disc-label').textContent = 'Wrapping up';

  // Pad out the last partial frame so the server only ever sees full 80 ms frames.
  if (rec.frameLen > 0) {
    rec.frame.fill(0, rec.frameLen);
    sendFrame(rec, rec.frame);
    rec.frameLen = 0;
  }
  endVideo(rec, true);
  releaseAudio(rec);

  const sendEnd = () => rec.ws.send(JSON.stringify({ type: 'end' }));
  if (rec.ws.readyState === WebSocket.OPEN) sendEnd();
  else if (rec.ws.readyState === WebSocket.CONNECTING) rec.ws.addEventListener('open', sendEnd, { once: true });

  rec.doneTimer = setTimeout(() => {
    if (rec.finished) return;
    showError('label-error', 'The transcript took too long to finish. Showing what arrived.');
    finishRecording(rec, rec.turns.length ? rec.turns : liveTurnsAsList(), { keepError: true });
  }, DONE_TIMEOUT_MS);
}

function finishRecording(rec, turns, { keepError = false, userLabel = null, labelSource, crowdTurns = 0 } = {}) {
  if (rec.finished) return;
  rec.finished = true;
  clearInterval(rec.timer);
  clearTimeout(rec.doneTimer);
  if (!rec.stopping) {
    // Socket died mid-recording. Stop the mic so the indicator goes away.
    rec.stopping = true;
    endVideo(rec, true);
    releaseAudio(rec);
    if (!keepError) showError('label-error', rec.lastError || 'The transcriber disconnected early. Here is what it caught.');
    keepError = true;
  }
  try { if (rec.ws.readyState <= WebSocket.OPEN) rec.ws.close(1000); } catch { /* ignore */ }
  state.rec = null;
  // The lip lock (or an "I'm Parth" in the transcript) may already know which voice is yours;
  // the label step then just confirms it. The server says which; an older one doesn't, and then
  // cues having gone out is the best guess.
  if (labelSource === undefined) labelSource = userLabel ? (rec.cuesSent ? 'camera' : 'name') : null;
  if (!userLabel) labelSource = null;
  state.convo = { ...state.convo, turns, userLabel, autoLabel: !!labelSource, labelSource, crowdTurns };
  showLabelView(keepError);
}

// ---------- who are you ----------

function showLabelView(keepError = false) {
  const convo = state.convo;
  const turns = convo.turns || [];
  if (!keepError) showError('label-error', null);
  showError('coach-error', null);
  // This view re-renders after a tap or a rename; the half-typed reflection has to survive that.
  // Only a different conversation starts the box over.
  const reflection = $('reflection');
  if (reflection.dataset.convo !== convo.id) {
    reflection.dataset.convo = convo.id;
    reflection.value = convo.reflection || '';
  }

  const voices = speakerLabels(turns).length;
  const hasVoices = voices > 0;
  const matched = hasVoices && !!convo.userLabel && !!convo.autoLabel;
  // Without the camera the only way we could know is that you said your own name.
  const matchedTitle = convo.labelSource === 'camera' ? 'We matched your voice to the camera'
    : convo.labelSource === 'name' ? 'We heard which voice is yours' : 'Which voice is yours?';
  $('label-title').textContent = !hasVoices ? 'Nothing to label' : matched ? matchedTitle : 'Which voice is yours?';
  $('label-hint').textContent = hasVoices
    ? (matched ? 'Not you? Tap your line.' : convo.userLabel ? 'Got it. Tap a different line if that was wrong.' : 'Tap one of your lines. Coaching only starts after this.')
    : 'No speech came through. You can still finish up.';
  // How many people the diarizer heard, so a loud room doesn't read as a bug.
  $('label-voices').hidden = voices < 2 || !!convo.userLabel;
  $('label-voices').textContent = `${voices} voices heard, one is you`;
  $('label-crowd').hidden = voices < 3 || !!convo.userLabel;
  $('label-transcript').dataset.empty = 'No lines were transcribed.';
  renderLabelWho();
  renderTranscript('label-transcript', turns, convo, { pickable: true, onPick: pickLabel });
  // With nobody to pick, let them go straight on; the server will say it's too short.
  $('reflect-block').hidden = hasVoices && !convo.userLabel;
  renderVideo();
  showView('label');
}

async function pickLabel(label) {
  showError('label-error', null);
  const buttons = $('label-transcript').querySelectorAll('button');
  buttons.forEach((b) => { b.disabled = true; });
  const id = state.convo.id;
  try {
    const updated = await api.setUserLabel(id, label);
    if (!stillOn('label', id)) return; // they left this conversation meanwhile
    state.convo = { ...state.convo, ...updated, turns: updated.turns || state.convo.turns, autoLabel: false };
    showLabelView();
    $('reflection').focus({ preventScroll: true });
    $('reflect-block').scrollIntoView({ block: 'start', behavior: 'smooth' });
  } catch (err) {
    buttons.forEach((b) => { b.disabled = false; });
    showError('label-error', err);
  }
}

async function getCoaching() {
  const btn = $('coach-btn');
  showError('coach-error', null);
  btn.disabled = true;
  btn.textContent = 'Reading the conversation…';
  const id = state.convo.id;
  try {
    const convo = await api.process(id, $('reflection').value.trim());
    if (!stillOn('label', id)) return; // they left this conversation meanwhile
    showCoaching(convo);
  } catch (err) {
    showError('coach-error', err);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Get coaching';
  }
}

// ---------- coaching ----------

function chipData(s) {
  s = s || {};
  return [
    ['Questions you asked', fmtNum(s.userQuestions)],
    ['Follow-ups', fmtNum(s.followUps)],
    ['Your share of the talking', fmtNum(talkSharePct(s.userTalkShare), '%')],
    ['Their average answer, in words', fmtNum(s.otherAvgAnswerWords)],
    ['Stories after your questions', fmtNum(s.storiesAfterQuestions)],
  ];
}

function showCoaching(convo) {
  state.convo = convo;
  showError('coaching-error', null);
  const note = convo.note;
  $('coach-title').textContent = isNamed(convo) ? `Your talk with ${convo.otherName}` : 'Your conversation';
  $('coach-meta').textContent = [TAG_NAMES[convo.tag], fmtDate(convo.createdAt)].filter(Boolean).join(', ');

  const dropped = !note || note.status === 'dropped' || !note.text;
  $('note-card').hidden = dropped;
  $('note-dropped').hidden = !dropped;
  if (dropped) {
    $('note-dropped').textContent = note && note.reason === 'too_short'
      ? 'Too short to coach. Try a longer conversation.'
      : 'No advice this time. Here are your counts.';
  } else {
    $('note-text').replaceChildren(...withSpeech(note.text));
    $('note-suggestion').textContent = note.suggestion || '';
  }

  $('chips').replaceChildren(...chipData(convo.signals).map(([label, value]) => el('li', { class: 'chip' },
    el('span', { class: 'chip-label', text: label }),
    el('span', { class: 'chip-num', text: value }),
  )));

  const cited = dropped ? [] : (note.citedTurnIds || []);
  $('coach-transcript').dataset.empty = 'No transcript for this one.';
  renderTranscript('coach-transcript', convo.turns || [], convo, { cited });

  renderHooks(convo);
  renderFollowUp(convo);
  renderVideo();
  loadCompare(convo);

  setCheckedTag('tag-retag', convo.tag);
  showView('coaching');
  $('coach-title').focus({ preventScroll: true });
}

// Scrolls the coaching transcript to a turn and flashes it.
function pointAtTurn(turnId, also) {
  const list = $('coach-transcript');
  const line = list.querySelector(`[data-turn="${turnId}"]`);
  if (!line) return;
  for (const old of list.querySelectorAll('.flagged')) old.classList.remove('flagged');
  for (const id of [turnId, also]) {
    const node = id == null ? null : list.querySelector(`[data-turn="${id}"]`);
    if (node) { void node.offsetWidth; node.classList.add('flagged'); }
  }
  line.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function turnText(convo, turnId) {
  const t = (convo.turns || []).find((x) => x.turnId === turnId);
  return t ? t.text : null;
}

// ---- compared with last time ----

let compareSeq = 0;

async function loadCompare(convo) {
  const card = $('compare-card');
  const seq = ++compareSeq;
  // Keep the old numbers up during a retag of the same conversation; wipe them otherwise.
  if (card.dataset.id !== convo.id) { card.hidden = true; card.replaceChildren(); }
  if (!convo.signals) { card.hidden = true; return; }
  let cmp = null;
  try { cmp = await api.getCompare(convo.id); } catch { /* endpoint missing or failed: just no card */ }
  if (seq !== compareSeq || !stillOn('coaching', convo.id)) return;
  renderCompare(state.convo, cmp);
}

function fmtMetric(key, v) {
  if (key === 'userTalkShare') return fmtNum(talkSharePct(v), '%');
  return fmtNum(v);
}

function compareArrow(m) {
  if (m.before == null || m.after == null || m.after === m.before) return '=';
  return m.after > m.before ? '↑' : '↓';
}

function betterClass(b) {
  return b === true ? 'better' : b === false ? 'worse' : 'same';
}

function renderCompare(convo, cmp) {
  const card = $('compare-card');
  card.dataset.id = convo.id;
  const metrics = cmp && Array.isArray(cmp.metrics) ? cmp.metrics : [];
  if (!cmp || !cmp.previousId || (!metrics.length && !cmp.suggestion)) {
    card.hidden = true; card.replaceChildren(); return;
  }
  const same = cmp.samePerson ?? cmp.sameperson;
  const sub = [
    cmp.previousAt ? `vs. ${fmtDate(cmp.previousAt)}` : 'vs. your last one',
    same && convo.otherName ? `with ${convo.otherName}` : null,
  ].filter(Boolean).join(' ');

  const rows = metrics.map((m) => el('li', { class: `cmp-row ${betterClass(m.better)}` },
    el('span', { class: 'cmp-label', text: m.label || m.key }),
    el('span', { class: 'cmp-vals' },
      el('span', { class: 'cmp-before', text: fmtMetric(m.key, m.before) }),
      el('span', { class: 'cmp-to', 'aria-hidden': 'true', text: '→' }),
      el('span', { class: 'cmp-after', text: fmtMetric(m.key, m.after) }),
    ),
    el('span', { class: 'cmp-arrow', 'aria-hidden': 'true', text: compareArrow(m) }),
  ));

  let sugg = null;
  if (cmp.suggestion && cmp.suggestion.text) {
    const s = cmp.suggestion;
    const evidence = s.followed && s.evidenceTurnId != null ? turnText(convo, s.evidenceTurnId) : null;
    sugg = el('div', { class: 'cmp-sugg' },
      el('p', { class: 'cmp-sugg-text' },
        el('span', { class: 'cmp-sugg-lead', text: 'Last note said: ' }),
        document.createTextNode(s.text)),
      el('span', { class: s.followed ? 'badge did' : 'badge', text: s.followed ? '✓ You did it' : 'Not yet' }),
      evidence ? el('button', {
        type: 'button', class: 'evidence',
        onclick: () => pointAtTurn(s.evidenceTurnId),
      }, el('span', { class: 'evidence-q', text: `“${evidence}”` })) : null,
    );
  }

  put(card,
    el('div', { class: 'card-head' },
      el('h2', { class: 'subtitle', id: 'compare-title', text: 'Compared with last time' }),
      el('span', { class: 'card-meta', text: sub })),
    rows.length ? el('ul', { class: 'cmp-rows' }, ...rows) : null,
    sugg,
  );
  card.hidden = false;
}

// ---- what we picked up ----

function chipList(items, toChip) {
  return el('ul', { class: 'hook-chips' }, ...items.map((it) => el('li', {}, toChip(it))));
}

function renderHooks(convo) {
  const card = $('hooks-card');
  const h = convo.hooks;
  if (!h) { card.hidden = true; card.replaceChildren(); return; }
  const list = (k) => (Array.isArray(h[k]) ? h[k] : []);
  const groups = [];
  const group = (label, items, toChip) => {
    if (items.length) groups.push(el('div', { class: 'hook-group' }, el('h3', { class: 'hook-label', text: label }), chipList(items, toChip)));
  };
  const plain = (text) => el('span', { class: 'hook-chip', text });

  // Awkward first: a cut-in or a rumour matters more than any topic list.
  const awkward = (h.awkward && Array.isArray(h.awkward.flags) ? h.awkward.flags : []).filter((f) => f.who === 'you');
  group('Awkward moments', awkward, (f) => {
    const chip = el('button', { type: 'button', class: 'hook-chip awkward', title: f.evidence, onclick: () => pointAtTurn(f.turnId) }, f.label);
    return turnText(convo, f.turnId) != null ? chip : el('span', { class: 'hook-chip awkward', title: f.evidence, text: f.label });
  });
  group('Topics', list('topics'), (t) => plain(t.term));
  group('Coming up', list('events'), (e) => plain(e.when && !String(e.text).includes(e.when) ? `${e.text} (${e.when})` : e.text));
  group('You promised', list('commitments'), (c) => plain(c.text));
  group('Missed moments', list('missedBids'), (b) => {
    const said = turnText(convo, b.turnId);
    // Only a button when there's a transcript line to jump to.
    return said != null
      ? el('button', { type: 'button', class: 'hook-chip missed', onclick: () => pointAtTurn(b.turnId, b.replyTurnId) }, b.cue || said)
      : el('span', { class: 'hook-chip missed', text: b.cue || 'A moment you moved past' });
  });

  const qs = list('followUpDetector');
  const detector = qs.length ? el('p', { class: 'hook-detector' },
    el('span', { class: 'hook-label', text: 'Follow-up detector: ' }),
    document.createTextNode(`${qs.filter((q) => q.isFollowUp).length} of ${qs.length} question${qs.length === 1 ? '' : 's'} built on what they said`),
  ) : null;

  const nCrowd = (convo.signals && convo.signals.crowd) || 0;
  const crowd = nCrowd ? el('p', { class: 'hook-detector' },
    el('span', { class: 'hook-label', text: 'Crowd filter: ' }),
    document.createTextNode(`${nCrowd} line${nCrowd === 1 ? '' : 's'} ignored`),
  ) : null;

  if (!groups.length && !detector && !crowd) { card.hidden = true; card.replaceChildren(); return; }
  put(card,
    el('div', { class: 'card-head' },
      el('h2', { class: 'subtitle', id: 'hooks-title', text: 'What we picked up' }),
      el('span', { class: 'card-meta', text: 'Measured from the transcript. No AI.' })),
    ...groups,
    detector,
    crowd,
  );
  card.hidden = false;
}

// ---- follow-up message ----

function renderFollowUp(convo) {
  const card = $('follow-card');
  const note = convo.note;
  const hasNote = note && note.status !== 'dropped' && note.text;
  const fu = convo.followUp;
  const id = convo.id;
  const err = el('p', { class: 'error', role: 'alert', hidden: true });
  const fail = (e) => { err.textContent = e.message; err.hidden = false; };
  const head = el('h2', { class: 'subtitle', id: 'follow-title', text: 'Follow-up message' });

  // One request at a time; the rest of the card sits still until it lands.
  const run = async (busyText, call, controls) => {
    err.hidden = true;
    card.setAttribute('aria-busy', 'true');
    controls.forEach((c) => { c.disabled = true; });
    const status = card.querySelector('.follow-status');
    if (status) status.textContent = busyText;
    try {
      const updated = await call();
      if (!stillOn('coaching', id)) return;
      state.convo = { ...state.convo, followUp: updated };
      renderFollowUp(state.convo);
    } catch (e) {
      if (!stillOn('coaching', id)) return;
      card.removeAttribute('aria-busy');
      controls.forEach((c) => { c.disabled = false; });
      if (status) status.textContent = '';
      fail(e);
    }
  };

  if (!fu || !fu.text) {
    if (!hasNote) { card.hidden = true; card.replaceChildren(); return; }
    const draft = el('button', { type: 'button', class: 'primary', text: 'Draft a follow-up' });
    const status = el('p', { class: 'follow-status hint' });
    draft.addEventListener('click', () => {
      draft.textContent = 'Drafting… this can take a few seconds';
      run('', () => api.followUp(id, {}), [draft]).finally(() => {
        if (draft.isConnected) draft.textContent = 'Draft a follow-up';
      });
    });
    card.removeAttribute('aria-busy');
    card.replaceChildren(head, el('p', { class: 'hint', text: 'A short message built from what they told you.' }), draft, status, err);
    card.hidden = false;
    return;
  }

  const sent = fu.status === 'sent';
  const ta = el('textarea', { class: 'follow-text', rows: 5, maxlength: 1000, 'aria-label': 'Follow-up message' });
  ta.value = fu.text;
  const used = Array.isArray(fu.hooksUsed) && fu.hooksUsed.length
    ? el('p', { class: 'follow-used', text: `Uses ${fu.hooksUsed.join(', ')}` }) : null;
  const status = el('p', { class: 'follow-status', text: sent ? `Sent ✓${fu.sentAt ? ` ${fmtDate(fu.sentAt)}` : ''}` : '' });
  const send = el('button', { type: 'button', class: 'accept', text: sent ? 'Send again' : 'Send' });
  const rewrite = el('button', { type: 'button', text: 'Rewrite' });
  const controls = [send, rewrite, ta];

  let lastSaved = fu.text;
  let saving = null;
  const save = () => {
    const text = ta.value.trim();
    if (!text || text === lastSaved) return saving || Promise.resolve();
    lastSaved = text;
    status.textContent = 'Saving…';
    saving = api.followUp(id, { text })
      .then((updated) => {
        if (!stillOn('coaching', id)) return;
        state.convo = { ...state.convo, followUp: updated };
        status.textContent = 'Saved';
      })
      .catch((e) => { lastSaved = null; status.textContent = ''; fail(e); throw e; })
      .finally(() => { saving = null; });
    return saving;
  };
  // iOS doesn't always blur on a tap elsewhere, so save as they type too.
  let typing = null;
  ta.addEventListener('input', () => { clearTimeout(typing); typing = setTimeout(() => save().catch(() => {}), 700); });
  ta.addEventListener('blur', () => { clearTimeout(typing); save().catch(() => {}); });

  send.addEventListener('click', async () => {
    const text = ta.value.trim();
    if (!text) { fail(new Error('Write something first, or tap Rewrite.')); return; }
    err.hidden = true;
    send.disabled = true; // a double tap would open two share sheets
    clearTimeout(typing);
    // share() has to be called straight from the tap or iOS refuses it, so nothing is awaited
    // first. The text goes along with "sent", so the server keeps what was actually shared
    // even if the edit save didn't make it.
    let how;
    try {
      how = await shareOrCopy(text, ta);
    } catch (e) {
      send.disabled = false;
      if (e && e.name === 'AbortError') return; // closed the share sheet
      fail(new Error('Couldn’t share or copy that. Select the text and copy it by hand.'));
      return;
    }
    if (!stillOn('coaching', id)) return;
    run(how === 'copied' ? 'Copied — paste it into your message' : 'Marking sent…', () => api.markFollowUpSent(id, text), controls);
  });

  rewrite.addEventListener('click', () => {
    rewrite.textContent = 'Rewriting…';
    run('Writing a new one… this can take a few seconds', () => api.followUp(id, { regenerate: true }), controls)
      .finally(() => { if (rewrite.isConnected) rewrite.textContent = 'Rewrite'; });
  });

  card.removeAttribute('aria-busy');
  put(card, head, ta, used, el('div', { class: 'follow-actions' }, send, rewrite), status, err);
  card.hidden = false;
}

async function shareOrCopy(text, ta) {
  if (navigator.share) {
    try {
      await navigator.share({ text });
      return 'shared';
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;
      // NotAllowedError and friends: fall through to copying
    }
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try { await navigator.clipboard.writeText(text); return 'copied'; } catch { /* old-school below */ }
  }
  ta.focus();
  ta.select();
  if (!document.execCommand('copy')) throw new Error('copy failed');
  return 'copied';
}

async function retag(tag) {
  const convo = state.convo;
  if (!convo || tag === convo.tag) return;
  const group = $('tag-retag');
  // One re-coach at a time, otherwise two quick taps race and the older
  // response can land last and show the wrong tag's note.
  group.disabled = true;
  group.setAttribute('aria-busy', 'true');
  showError('coaching-error', null);
  try {
    const updated = await api.retag(convo.id, tag);
    if (!stillOn('coaching', convo.id)) return;
    showCoaching(updated);
  } catch (err) {
    if (stillOn('coaching', convo.id)) {
      setCheckedTag('tag-retag', convo.tag);
      showError('coaching-error', err);
    }
  } finally {
    group.disabled = false;
    group.removeAttribute('aria-busy');
  }
}

async function deleteConversation() {
  const convo = state.convo;
  if (!convo) return;
  if (!window.confirm('Delete this conversation and its note? This can’t be undone.')) return;
  const btn = $('delete-btn');
  btn.disabled = true;
  showError('coaching-error', null);
  try {
    await api.remove(convo.id);
    dropUpload(convo.id);
    state.convo = null;
    await openMemory();
  } catch (err) {
    showError('coaching-error', err);
  } finally {
    btn.disabled = false;
  }
}

// ---------- memory ----------

async function openMemory() {
  showView('memory');
  showError('memory-error', null);
  $('pattern-block').replaceChildren(el('p', { class: 'empty', text: 'Loading…' }));
  $('next-step-block').replaceChildren();
  $('convo-list').replaceChildren();
  let mem;
  try {
    mem = await api.memory();
  } catch (err) {
    $('pattern-block').replaceChildren();
    showError('memory-error', err);
    return;
  }
  renderPattern(mem.pattern, mem.signalTable || []);
  renderNextStep(mem.nextStep);
  renderConvoList(mem.conversations || []);
  unfinished = (mem.conversations || []).filter((c) => c.needsLabel);
  renderFinishBanner();
  $('memory-title').focus({ preventScroll: true });
}

function renderPattern(pattern, table) {
  const block = $('pattern-block');
  if (pattern && pattern.statement) {
    const counts = Array.isArray(pattern.counts) ? pattern.counts : [];
    const max = Math.max(1, ...counts.map((n) => Number(n) || 0));
    const bars = el('ol', { class: 'bars', 'aria-label': `Counts by conversation, oldest first: ${counts.join(', ')}` },
      ...counts.map((n) => el('li', {},
        el('span', { class: 'bar-num', text: String(n) }),
        el('span', { class: 'bar-fill', style: `height:${Math.round(((Number(n) || 0) / max) * 100)}%` }),
      )));
    block.replaceChildren(el('div', { class: 'pattern' },
      el('p', { class: 'pattern-statement', text: pattern.statement }),
      counts.length ? bars : null,
    ));
    return;
  }
  if (!table.length) {
    block.replaceChildren(el('p', { class: 'empty', text: 'A trend shows up here after a few conversations.' }));
    return;
  }
  const head = el('tr', {},
    el('th', { scope: 'col', text: 'Conversation' }),
    el('th', { scope: 'col', text: 'Questions' }),
    el('th', { scope: 'col', text: 'Follow-ups' }),
    el('th', { scope: 'col', text: 'Their answers' }),
    el('th', { scope: 'col', text: 'You talked' }),
  );
  const rows = table.map((r) => el('tr', {},
    el('td', { text: `${fmtDate(r.createdAt)} ${r.otherName || TAG_NAMES[r.tag] || ''}`.trim() }),
    el('td', { text: fmtNum(r.userQuestions) }),
    el('td', { text: fmtNum(r.followUps) }),
    el('td', { text: fmtNum(r.otherAvgAnswerWords) }),
    el('td', { text: fmtNum(talkSharePct(r.userTalkShare), '%') }),
  ));
  block.replaceChildren(
    el('p', { class: 'hint', text: 'No clear trend yet. Here are your numbers so far.' }),
    el('div', { class: 'table-wrap' },
      el('table', { class: 'signal-table' }, el('thead', {}, head), el('tbody', {}, ...rows))),
  );
}

function renderNextStep(step) {
  const block = $('next-step-block');
  if (!step || step.status === 'dismissed') { block.replaceChildren(); return; }

  const card = el('section', { class: 'next-step', 'aria-labelledby': 'ns-title' });
  const err = el('p', { class: 'error', role: 'alert', hidden: true });
  const fail = (e) => { err.textContent = e.message; err.hidden = false; };

  const act = async (action, text, buttons) => {
    err.hidden = true;
    buttons.forEach((b) => { b.disabled = true; });
    try {
      const updated = await api.nextStep(step.id, action, text);
      renderNextStep(updated);
    } catch (e) {
      buttons.forEach((b) => { b.disabled = false; });
      fail(e);
    }
  };

  const statusCopy = step.status === 'accepted' ? 'You’re on it this week.'
    : step.status === 'changed' ? 'Your version.' : null;

  const actions = el('div', { class: 'actions' });
  const accept = el('button', { type: 'button', class: 'accept', text: 'Accept' });
  const change = el('button', { type: 'button', text: 'Change' });
  const dismiss = el('button', { type: 'button', text: 'Dismiss' });
  const all = [accept, change, dismiss];
  accept.addEventListener('click', () => act('accept', undefined, all));
  dismiss.addEventListener('click', () => act('dismiss', undefined, all));
  change.addEventListener('click', () => {
    const ta = el('textarea', { 'aria-label': 'Your version of the next step', maxlength: 300 });
    ta.value = step.text;
    const save = el('button', { type: 'button', class: 'accept', text: 'Save' });
    const cancel = el('button', { type: 'button', text: 'Cancel' });
    save.addEventListener('click', () => {
      const text = ta.value.trim();
      if (!text) { fail(new Error('Write the step you want to try, or tap Cancel.')); return; }
      act('change', text, [save, cancel]);
    });
    cancel.addEventListener('click', () => renderNextStep(step));
    actions.replaceChildren(save, cancel, el('span'));
    card.querySelector('.next-step-text').replaceWith(ta);
    ta.focus();
  });
  if (step.status === 'proposed') actions.append(accept, change, dismiss);
  else actions.append(change, dismiss);

  card.append(...[
    el('h2', { class: 'subtitle', id: 'ns-title', text: 'This week, try' }),
    el('p', { class: 'next-step-text', text: step.text }),
    statusCopy ? el('p', { class: 'next-step-status', text: statusCopy }) : null,
    actions,
    err,
  ].filter(Boolean));
  block.replaceChildren(card);
}

function renderConvoList(convos) {
  const list = $('convo-list');
  if (!convos.length) {
    list.replaceChildren(el('li', { class: 'empty', text: 'Nothing yet. Record your first conversation.' }));
    return;
  }
  const sorted = [...convos].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  list.replaceChildren(...sorted.map((c) => {
    const sub = [el('span', { class: 'tag-pill', text: TAG_NAMES[c.tag] || c.tag })];
    if (c.seeded) sub.push(document.createTextNode(' Sample'));
    if (c.needsLabel) sub.push(el('span', { class: 'tag needs-tap', text: 'Needs your tap' }));
    else if (c.note && c.note.status === 'dropped') sub.push(document.createTextNode(' Counts only'));
    // 'them' is the server's placeholder, not a name.
    const name = isNamed(c) ? c.otherName : 'Someone';
    // Up to two initials, like the avatars in the design. Whole code points: w[0] on an emoji is half a surrogate pair.
    const initials = isNamed(c) ? name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => Array.from(w)[0].toUpperCase()).join('') : '?';
    return el('li', {}, el('button', {
      type: 'button',
      onclick: () => openConversation(c),
    },
    el('span', { class: 'convo-avatar', 'aria-hidden': 'true', text: initials }),
    el('span', { class: 'convo-name', text: name }),
    el('span', { class: 'convo-date', text: fmtDate(c.createdAt) }),
    el('span', { class: 'convo-sub' }, ...sub),
    ));
  }));
}

function openConversation(c) {
  state.convo = c;
  if (c.note || c.signals) showCoaching(c);
  else showLabelView(); // recorded but never processed
}

// ---------- logs ----------

async function openLogs() {
  const dlg = $('logs-drawer');
  const list = $('logs-list');
  showError('logs-error', null);
  list.replaceChildren(el('li', { class: 'empty', text: 'Loading…' }));
  if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
  try {
    const data = await api.logs();
    const rows = (Array.isArray(data) ? data : (data && data.logs) || []).slice(0, 100);
    if (!rows.length) { list.replaceChildren(el('li', { class: 'empty', text: 'No log lines yet.' })); return; }
    list.replaceChildren(...rows.map((r) => {
      const time = r.ts ? new Date(r.ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
      return el('li', { class: `lv-${r.level || 'info'}` },
        el('span', { class: 'log-meta', text: `${time} ${r.agent || ''} ${r.level && r.level !== 'info' ? r.level : ''}`.trim() }),
        document.createElement('br'),
        document.createTextNode(r.message || ''),
      );
    }));
  } catch (err) {
    list.replaceChildren();
    showError('logs-error', err);
  }
}

function closeLogs() {
  const dlg = $('logs-drawer');
  if (typeof dlg.close === 'function') dlg.close(); else dlg.removeAttribute('open');
}

// ---------- wiring ----------

function confirmLeaveRecording() {
  if (!state.rec) return true;
  return window.confirm('Stop recording and leave? The transcript so far will be lost.');
}

function abandonRecording() {
  const rec = state.rec;
  if (!rec) return;
  rec.finished = true;
  rec.stopping = true;
  clearInterval(rec.timer);
  clearTimeout(rec.doneTimer);
  endVideo(rec, false);
  releaseAudio(rec);
  try { rec.ws.close(1000); } catch { /* ignore */ }
  state.rec = null;
  // The confirm said the transcript would be lost, so don't leave the conversation behind
  // for the server to fill in with whatever Muse still had.
  const id = state.convo && state.convo.id;
  if (id) {
    dropUpload(id);
    state.convo = null;
    api.remove(id).catch(() => {});
  }
}

function init() {
  for (const input of document.querySelectorAll('input[name="tag-start"]')) input.addEventListener('change', updateFocus);
  for (const input of document.querySelectorAll('input[name="tag-retag"]')) {
    input.addEventListener('change', () => input.checked && retag(input.value));
  }
  $('consent').addEventListener('change', updateRecordEnabled);
  $('camera').addEventListener('change', updateCamera);
  $('other-name').addEventListener('input', onNameInput);
  $('add-name-btn').addEventListener('click', () => showNameField(true));
  $('record-btn').addEventListener('click', startRecording);
  $('stop-btn').addEventListener('click', stopRecording);
  $('rec-person').addEventListener('click', startNameEdit);
  $('person-edit').addEventListener('submit', saveNameEdit);
  $('person-input').addEventListener('keydown', (e) => { if (e.key === 'Escape') cancelNameEdit(); });
  $('coach-btn').addEventListener('click', getCoaching);
  $('delete-btn').addEventListener('click', deleteConversation);
  $('to-memory-btn').addEventListener('click', openMemory);
  $('new-convo-btn').addEventListener('click', resetStart);
  $('go-home').addEventListener('click', () => { if (confirmLeaveRecording()) { abandonRecording(); resetStart(); } });
  $('go-memory').addEventListener('click', () => { if (confirmLeaveRecording()) { abandonRecording(); openMemory(); } });
  $('open-logs').addEventListener('click', openLogs);
  $('close-logs').addEventListener('click', closeLogs);
  $('logs-drawer').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeLogs(); });

  $('camera').checked = CAN_RECORD_VIDEO;
  $('camera').disabled = !CAN_RECORD_VIDEO;
  updateFocus();
  updateCamera();
  updateRecordEnabled();
  refreshFinishBanner();
  api.stageFocus('start', null); // a reload lands on start, so tell the projector

  api.health()
    .then((h) => { $('mock-badge').hidden = !(h && h.mock); })
    .catch((err) => showError('start-error', err));
}

init();

import { api, transcribeSocketUrl } from './api.js';
import { createResampler, micErrorMessage } from './mic.js';

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
  suggestion: ['→', 'Try'],
};
const BRIEF_DEBOUNCE_MS = 400;

const FRAME_SAMPLES = 1920; // 80 ms at 24 kHz = 3840 bytes
const DONE_TIMEOUT_MS = 20000;

const $ = (id) => document.getElementById(id);

const state = {
  convo: null,          // the Conversation we're working on
  liveTurns: new Map(), // turnId -> { speaker, text, partial }
  rec: null,            // active recording handles
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

// Distinct real speaker labels in first-seen order.
function speakerLabels(turns) {
  const seen = [];
  for (const t of turns) if (t.speaker !== 'unknown' && !seen.includes(t.speaker)) seen.push(t.speaker);
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
  if (others.length === 1 && convo.otherName) return convo.otherName;
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
    const cls = lineClass(t.speaker, convo, labels) + (cited.includes(t.turnId) ? ' cited' : '');
    const who = el('span', { class: 'who', text: speakerName(t.speaker, convo, labels) });
    const said = el('span', { class: 'said', text: t.text });
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

// ---------- start view ----------

function updateFocus() {
  $('tag-focus').textContent = TAG_FOCUS[checkedTag('tag-start')];
}

function updateRecordEnabled() {
  const ok = $('consent').checked;
  $('record-btn').disabled = !ok;
  $('record-hint').textContent = ok
    ? 'Tap to start. Tap again to stop.'
    : 'Tick the box once they know, then tap to start.';
}

function resetStart() {
  $('other-name').value = '';
  clearTimeout(briefTimer);
  briefSeq += 1;
  renderBrief(null);
  $('consent').checked = false;
  setCheckedTag('tag-start', 'family');
  updateFocus();
  updateRecordEnabled();
  showError('start-error', null);
  showView('start');
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

function renderBrief(brief) {
  const card = $('brief-card');
  const items = brief && Array.isArray(brief.items) ? brief.items : [];
  if (!items.length) { card.hidden = true; card.replaceChildren(); return; }
  const meta = [
    brief.lastMetAt ? `Last talked ${fmtDate(brief.lastMetAt)}` : null,
    brief.conversations ? `${brief.conversations} conversation${brief.conversations === 1 ? '' : 's'}` : null,
  ].filter(Boolean).join(' · ');
  card.replaceChildren(
    el('h2', { class: 'subtitle', id: 'brief-title', text: `Before you talk to ${brief.otherName || 'them'}` }),
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
  let stream = null;
  try {
    if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('getUserMedia unavailable');
    }
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true },
    });
    await ctx.audioWorklet.addModule('pcm-worklet.js');
  } catch (err) {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    ctx.close().catch(() => {});
    btn.removeAttribute('aria-busy');
    showError('start-error', micErrorMessage(err, { isSecureContext: window.isSecureContext }));
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
  beginCapture(convo, ctx, stream);
}

function beginCapture(convo, ctx, stream) {
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
  };
  state.rec = rec;

  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'pcm-capture');
  // Safari won't pull audio through a node that isn't connected to the output,
  // so route it into a muted gain.
  const mute = ctx.createGain();
  mute.gain.value = 0;
  source.connect(node);
  node.connect(mute);
  mute.connect(ctx.destination);
  rec.node = node;
  rec.source = source;

  node.port.onmessage = (e) => {
    if (rec.stopping) return;
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
  $('rec-with').textContent = convo.otherName
    ? `With ${convo.otherName}. ${TAG_NAMES[convo.tag]}.`
    : `${TAG_NAMES[convo.tag]} conversation.`;
  $('rec-timer').textContent = '0:00';
  $('live-transcript').replaceChildren();
  $('live-transcript').dataset.empty = 'Listening…';
  showError('rec-error', null);
  $('stop-btn').disabled = false;
  $('stop-btn').querySelector('.disc-label').textContent = 'Stop';
  rec.timer = setInterval(() => {
    const s = Math.floor((Date.now() - rec.startedAt) / 1000);
    $('rec-timer').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }, 500);
  showView('recording');
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
    case 'done':
      finishRecording(rec, Array.isArray(msg.turns) ? msg.turns : rec.turns);
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

function finishRecording(rec, turns, { keepError = false } = {}) {
  if (rec.finished) return;
  rec.finished = true;
  clearInterval(rec.timer);
  clearTimeout(rec.doneTimer);
  if (!rec.stopping) {
    // Socket died mid-recording. Stop the mic so the indicator goes away.
    rec.stopping = true;
    releaseAudio(rec);
    if (!keepError) showError('label-error', rec.lastError || 'The transcriber disconnected early. Here is what it caught.');
    keepError = true;
  }
  try { if (rec.ws.readyState <= WebSocket.OPEN) rec.ws.close(1000); } catch { /* ignore */ }
  state.rec = null;
  state.convo = { ...state.convo, turns, userLabel: null };
  showLabelView(keepError);
}

// ---------- who are you ----------

function showLabelView(keepError = false) {
  const convo = state.convo;
  const turns = convo.turns || [];
  if (!keepError) showError('label-error', null);
  showError('coach-error', null);
  $('reflection').value = convo.reflection || '';

  const hasVoices = speakerLabels(turns).length > 0;
  $('label-title').textContent = hasVoices ? 'Which voice is yours?' : 'Nothing to label';
  $('label-hint').textContent = hasVoices
    ? (convo.userLabel ? 'Got it. Tap a different line if that was wrong.' : 'Tap one of your own lines.')
    : 'No speech came through. You can still finish up.';
  $('label-transcript').dataset.empty = 'No lines were transcribed.';
  renderTranscript('label-transcript', turns, convo, { pickable: true, onPick: pickLabel });
  // With nobody to pick, let them go straight on; the server will say it's too short.
  $('reflect-block').hidden = hasVoices && !convo.userLabel;
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
    state.convo = { ...state.convo, ...updated, turns: updated.turns || state.convo.turns };
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
  const who = convo.otherName || 'them';
  $('coach-title').textContent = `Your talk with ${who}`;
  $('coach-meta').textContent = [TAG_NAMES[convo.tag], fmtDate(convo.createdAt)].filter(Boolean).join(', ');

  const dropped = !note || note.status === 'dropped' || !note.text;
  $('note-card').hidden = dropped;
  $('note-dropped').hidden = !dropped;
  if (dropped) {
    $('note-dropped').textContent = note && note.reason === 'too_short'
      ? 'Too short to coach — try a longer conversation.'
      : 'No advice this time — here are your counts.';
  } else {
    $('note-text').textContent = note.text;
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

  card.replaceChildren(
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

  if (!groups.length && !detector) { card.hidden = true; card.replaceChildren(); return; }
  card.replaceChildren(
    el('div', { class: 'card-head' },
      el('h2', { class: 'subtitle', id: 'hooks-title', text: 'What we picked up' }),
      el('span', { class: 'card-meta', text: 'Measured from the transcript. No AI.' })),
    ...groups,
    detector,
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
    ? el('p', { class: 'follow-used', text: `uses: ${fu.hooksUsed.join(' · ')}` }) : null;
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
  card.replaceChildren(head, ta, used, el('div', { class: 'follow-actions' }, send, rewrite), status, err);
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
    if (c.note && c.note.status === 'dropped') sub.push(document.createTextNode(' Counts only'));
    return el('li', {}, el('button', {
      type: 'button',
      onclick: () => openConversation(c),
    },
    el('span', { class: 'convo-name', text: c.otherName || 'Someone' }),
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
  releaseAudio(rec);
  try { rec.ws.close(1000); } catch { /* ignore */ }
  state.rec = null;
}

function init() {
  for (const input of document.querySelectorAll('input[name="tag-start"]')) input.addEventListener('change', updateFocus);
  for (const input of document.querySelectorAll('input[name="tag-retag"]')) {
    input.addEventListener('change', () => input.checked && retag(input.value));
  }
  $('consent').addEventListener('change', updateRecordEnabled);
  $('other-name').addEventListener('input', onNameInput);
  $('record-btn').addEventListener('click', startRecording);
  $('stop-btn').addEventListener('click', stopRecording);
  $('coach-btn').addEventListener('click', getCoaching);
  $('delete-btn').addEventListener('click', deleteConversation);
  $('to-memory-btn').addEventListener('click', openMemory);
  $('new-convo-btn').addEventListener('click', resetStart);
  $('go-home').addEventListener('click', () => { if (confirmLeaveRecording()) { abandonRecording(); resetStart(); } });
  $('go-memory').addEventListener('click', () => { if (confirmLeaveRecording()) { abandonRecording(); openMemory(); } });
  $('open-logs').addEventListener('click', openLogs);
  $('close-logs').addEventListener('click', closeLogs);
  $('logs-drawer').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeLogs(); });

  updateFocus();
  updateRecordEnabled();
  api.stageFocus('start', null); // a reload lands on start, so tell the projector

  api.health()
    .then((h) => { $('mock-badge').hidden = !(h && h.mock); })
    .catch((err) => showError('start-error', err));
}

init();

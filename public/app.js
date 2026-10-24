import { api, transcribeSocketUrl } from './api.js';
import { createResampler, micErrorMessage } from './mic.js';

// Spec copy, verbatim. Mirrors src/agents/context.js TAG_FOCUS.
const TAG_FOCUS = {
  family: 'Phrases to keep the conversation going, cultural context for what they said, a vocab list from words that came up',
  friend: 'Follow-up questions, remembering what matters to them, following through',
  networking: 'Clear questions, listening before pitching, a drafted follow-up message',
};
const TAG_NAMES = { family: 'Family', friend: 'Friend', networking: 'Networking' };

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
  $('consent').checked = false;
  setCheckedTag('tag-start', 'family');
  updateFocus();
  updateRecordEnabled();
  showError('start-error', null);
  showView('start');
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

  setCheckedTag('tag-retag', convo.tag);
  showView('coaching');
  $('coach-title').focus({ preventScroll: true });
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

  api.health()
    .then((h) => { $('mock-badge').hidden = !(h && h.mock); })
    .catch((err) => showError('start-error', err));
}

init();

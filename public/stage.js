// Projector page. Read-only: it follows whatever the phone is showing via
// /ws/stage and never sends anything back. All user text goes in via textContent.

const TAG_NAMES = { family: 'Family', friend: 'Friend', networking: 'Networking' };
const VIEWS = ['start', 'recording', 'label', 'coaching', 'memory'];
const METRIC_LABELS = {
  followUps: 'Follow-up questions, per conversation',
  userQuestions: 'Questions you asked, per conversation',
  otherAvgAnswerWords: 'Their average answer in words, per conversation',
  userTalkShare: 'Your share of the talking, per conversation',
};
const STEP_STATUS = { proposed: 'Suggested', accepted: 'Accepted', changed: 'Your version' };
const PROCESSING_GIVE_UP_MS = 30000;

const $ = (id) => document.getElementById(id);

const state = {
  mock: false,
  view: 'start',
  convoId: null,
  convos: new Map(),     // id -> Conversation
  live: new Map(),       // id -> Map(turnId -> { speaker, text, partial })
  doneTurns: new Map(),  // id -> Turn[] from the 'done' message
  processing: new Map(), // id -> give-up timer
  rec: null,             // { id, startedAt, stoppedAt }
  memory: null,
  pendingTagId: null,    // a conversation created but not recorded yet
  shownNote: new Map(),  // id -> { tag, key } of what's on screen, for the retag swap
  rendered: new Set(),   // `${list}:${turnId}` already drawn, so only new lines animate
};

// ---------- helpers ----------

function el(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids) if (kid != null) node.append(kid);
  return node;
}

const fmtNum = (v, suffix = '') => (v === null || v === undefined || Number.isNaN(v) ? '—' : `${v}${suffix}`);
const pct = (share) => (share === null || share === undefined ? null : Math.round(share * 100));

function fmtDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function fmtClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function speakerLabels(turns) {
  const seen = [];
  for (const t of turns) if (t.speaker && t.speaker !== 'unknown' && !seen.includes(t.speaker)) seen.push(t.speaker);
  return seen;
}

// Same naming rules as the phone: "Speaker A" until the user picks, then
// "You", and the typed name only when there's exactly one other voice.
function speakerName(speaker, convo, labels) {
  if (!speaker || speaker === 'unknown') return 'Unclear';
  const userLabel = convo && convo.userLabel;
  if (!userLabel) return `Speaker ${speaker}`;
  if (speaker === userLabel) return 'You';
  const others = labels.filter((l) => l !== userLabel);
  if (others.length === 1 && convo.otherName) return convo.otherName;
  return `Speaker ${speaker}`;
}

function lineClass(speaker, convo, labels) {
  if (!speaker || speaker === 'unknown') return 'st-line';
  const userLabel = convo && convo.userLabel;
  if (userLabel) return speaker === userLabel ? 'st-line is-you' : 'st-line is-them';
  const idx = labels.indexOf(speaker);
  return idx === 0 || idx === 1 ? `st-line spk-${idx}` : 'st-line';
}

function liveList(id) {
  const m = state.live.get(id);
  if (!m) return [];
  return [...m.entries()].sort((a, b) => a[0] - b[0])
    .map(([turnId, t]) => ({ turnId, speaker: t.speaker, text: t.text, partial: t.partial }));
}

// Best transcript we have for a conversation, newest source wins.
function turnsFor(id, { withPartials = false } = {}) {
  const c = state.convos.get(id);
  if (c && Array.isArray(c.turns) && c.turns.length) return c.turns;
  if (state.doneTurns.has(id)) return state.doneTurns.get(id);
  const live = liveList(id);
  return withPartials ? live : live.filter((t) => !t.partial);
}

function tagPill(node, tag) {
  node.hidden = !tag;
  node.textContent = tag ? TAG_NAMES[tag] || tag : '';
}

async function getJson(path) {
  const res = await fetch(path, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${path} ${res.status}`);
  return res.json();
}

// ---------- transcript ----------

function renderLines(listId, turns, convo, { cited = [], emptyText = '' } = {}) {
  const list = $(listId);
  const labels = speakerLabels(turns);
  if (!turns.length) {
    list.replaceChildren(el('li', { class: 'st-empty', text: emptyText }));
    return;
  }
  list.replaceChildren(...turns.map((t) => {
    const key = `${listId}:${convo ? convo.id : ''}:${t.turnId}`;
    let cls = lineClass(t.speaker, convo, labels);
    if (t.partial) cls += ' partial';
    if (cited.includes(t.turnId)) cls += ' cited';
    if (!state.rendered.has(key)) { cls += ' enter'; state.rendered.add(key); }
    return el('li', { class: cls, 'data-turn': t.turnId },
      el('span', { class: 'st-who', text: speakerName(t.speaker, convo, labels) }),
      el('span', { class: 'st-said', text: t.text || '' }),
    );
  }));
}

function scrollToBottom(box) {
  box.scrollTop = box.scrollHeight;
}

// ---------- views ----------

function showSection(id) {
  for (const s of document.querySelectorAll('.st-view')) {
    const on = s.id === id;
    if (s.hidden === on) s.hidden = !on;
  }
}

function render() {
  const view = state.view;
  const convo = state.convoId ? state.convos.get(state.convoId) : null;
  const status = $('status');
  if (view === 'start') {
    showSection('v-start');
    const pending = state.pendingTagId && state.convos.get(state.pendingTagId);
    tagPill($('start-tag'), pending ? pending.tag : null);
    status.textContent = '';
  } else if (view === 'recording' || view === 'label') {
    showSection('v-script');
    renderScript(view, convo);
    status.textContent = convo && convo.otherName ? `With ${convo.otherName}` : '';
  } else if (view === 'coaching') {
    showSection('v-coach');
    renderCoaching(convo);
    status.textContent = convo ? fmtDate(convo.createdAt) : '';
  } else if (view === 'memory') {
    showSection('v-memory');
    renderMemory();
    status.textContent = '';
  }
}

function renderScript(view, convo) {
  const id = state.convoId;
  const recording = view === 'recording';
  tagPill($('script-tag'), convo ? convo.tag : null);

  const ind = $('rec-ind');
  ind.classList.toggle('stopped', !recording);
  $('rec-word').textContent = recording ? 'Recording' : 'Recorded';
  updateTimer();

  let title = '';
  if (!recording) {
    if (convo && convo.userLabel) title = `You and ${convo.otherName || 'them'}`;
    else title = 'Picking which voice is you…';
  }
  $('script-title').textContent = title;

  const turns = recording ? (liveList(id).length ? liveList(id) : turnsFor(id)) : turnsFor(id, { withPartials: true });
  renderLines('script-lines', turns, recording ? null : convo, {
    emptyText: recording ? 'Listening…' : 'No lines came through.',
  });
  requestAnimationFrame(() => scrollToBottom($('script-scroll')));
}

function updateTimer() {
  const timer = $('rec-timer');
  const rec = state.rec;
  if (!rec || rec.id !== state.convoId) {
    timer.hidden = state.view !== 'recording';
    timer.textContent = '0:00';
    return;
  }
  timer.hidden = false;
  timer.textContent = fmtClock((rec.stoppedAt || Date.now()) - rec.startedAt);
}

function startTimer(id) {
  if (state.rec && state.rec.id === id) return;
  state.rec = { id, startedAt: Date.now(), stoppedAt: null };
}

function stopTimer(id) {
  if (state.rec && state.rec.id === id && !state.rec.stoppedAt) state.rec.stoppedAt = Date.now();
}

function signalRows(s) {
  s = s || {};
  return [
    ['Questions you asked', fmtNum(s.userQuestions)],
    ['Follow-ups', fmtNum(s.followUps)],
    ['Your share of the talking', fmtNum(pct(s.userTalkShare), '%')],
    ['Their average answer, in words', fmtNum(s.otherAvgAnswerWords)],
    ['Stories after your questions', fmtNum(s.storiesAfterQuestions)],
  ];
}

function renderCoaching(convo) {
  const id = state.convoId;
  const busy = id && state.processing.has(id);
  $('coach-title').textContent = convo
    ? `Your talk with ${convo.otherName || 'them'}`
    : 'Your talk';

  const tagNode = $('coach-tag');
  const prev = id ? state.shownNote.get(id) : null;
  tagPill(tagNode, convo ? convo.tag : null);

  const note = convo && convo.note;
  const hasResult = convo && (convo.note || convo.signals);
  const showBusy = busy || !hasResult;
  $('coach-processing').hidden = !showBusy;

  const card = $('note');
  const dropped = !note || note.status === 'dropped' || !note.text;
  if (showBusy) {
    card.hidden = true;
    $('note-dropped').hidden = true;
  } else {
    const key = dropped ? `dropped:${note && note.reason}` : `${note.text}|${note.suggestion || ''}`;
    const tagChanged = prev && prev.tag !== convo.tag;
    const textChanged = prev && prev.key !== key;
    if (tagChanged) {
      tagNode.classList.remove('flash');
      void tagNode.offsetWidth;
      tagNode.classList.add('flash');
    }
    state.shownNote.set(id, { tag: convo.tag, key });

    $('note-dropped').hidden = !dropped;
    if (dropped) {
      card.hidden = true;
      $('note-dropped').textContent = note && note.reason === 'too_short'
        ? 'Too short to coach. Try a longer conversation.'
        : 'No advice this time. Here are your counts.';
    } else if (textChanged && !card.hidden) {
      // Retag while the old note is still up: slide it off, then bring the new one in.
      card.classList.remove('swap-in');
      card.classList.add('swap-out');
      setTimeout(() => {
        fillNote(card, note);
        card.classList.remove('swap-out');
        void card.offsetWidth;
        card.classList.add('swap-in');
      }, 280);
    } else {
      fillNote(card, note);
      if (textChanged || card.hidden) {
        card.classList.remove('swap-in', 'swap-out');
        void card.offsetWidth;
        card.classList.add('swap-in');
      }
      card.hidden = false;
    }
  }

  $('signals').replaceChildren(...signalRows(convo && convo.signals).map(([label, value]) => el('li', { class: 'st-signal' },
    el('span', { class: 'st-signal-label', text: label }),
    el('span', { class: 'st-signal-num', text: showBusy && !(convo && convo.signals) ? '—' : value }),
  )));

  const cited = !showBusy && !dropped ? note.citedTurnIds || [] : [];
  renderLines('coach-lines', turnsFor(id), convo, { cited, emptyText: 'No transcript for this one.' });
  requestAnimationFrame(() => {
    const box = $('coach-scroll');
    const first = $('coach-lines').querySelector('.cited');
    box.scrollTop = first ? Math.max(0, first.offsetTop - box.clientHeight * 0.2) : 0;
  });
}

function fillNote(card, note) {
  $('note-text').textContent = note.text;
  $('note-sugg').textContent = note.suggestion || '';
  const len = (note.text || '').length + (note.suggestion || '').length;
  card.classList.toggle('long', len > 260);
  card.hidden = false;
}

function renderMemory() {
  const mem = state.memory;
  const block = $('pattern');
  if (!mem) {
    block.replaceChildren(el('p', { class: 'st-hint', text: 'Loading…' }));
    $('next-step').replaceChildren();
    $('convos').replaceChildren();
    return;
  }
  const table = mem.signalTable || [];
  const pattern = mem.pattern;
  if (pattern && pattern.statement) {
    const counts = Array.isArray(pattern.counts) ? pattern.counts : [];
    const isShare = pattern.metric === 'userTalkShare';
    const values = counts.map((n) => Number(n) || 0);
    const max = Math.max(isShare ? 0.01 : 1, ...values);
    const shown = (n) => (isShare ? `${pct(n)}%` : String(n));
    // signalTable and pattern.counts are both oldest-first over processed
    // conversations, so when they line up we can name each bar.
    const names = table.length === counts.length
      ? table.map((r) => fmtDate(r.createdAt))
      : null;
    // Memory refetches on every next-step tap; only grow the bars when the numbers moved.
    const barsKey = `${pattern.metric}:${counts.join(',')}`;
    const still = block.dataset.bars === barsKey;
    block.dataset.bars = barsKey;
    block.replaceChildren(
      el('p', { class: 'st-pattern-statement', text: pattern.statement }),
      el('div', { class: 'st-bars-wrap' },
        el('p', { class: 'st-bars-label', text: METRIC_LABELS[pattern.metric] || 'Per conversation, oldest first' }),
        el('ol', { class: still ? 'st-bars still' : 'st-bars', 'aria-label': `Oldest first: ${counts.map(shown).join(', ')}` },
          ...values.map((n) => el('li', {},
            el('span', { class: 'st-bar-num', text: shown(n) }),
            el('span', { class: 'st-bar-fill', style: `height:${Math.max(2, Math.round((n / max) * 78))}%` }),
          ))),
        names ? el('ol', { class: 'st-bar-axis', 'aria-hidden': 'true' }, ...names.map((n) => el('li', { text: n }))) : null,
      ),
    );
  } else if (table.length) {
    const head = el('tr', {},
      el('th', { scope: 'col', text: 'Conversation' }),
      el('th', { scope: 'col', text: 'Questions' }),
      el('th', { scope: 'col', text: 'Follow-ups' }),
      el('th', { scope: 'col', text: 'Their answers' }),
      el('th', { scope: 'col', text: 'You talked' }),
    );
    const rows = table.slice(-6).map((r) => el('tr', {},
      el('td', { text: `${fmtDate(r.createdAt)} ${r.otherName || TAG_NAMES[r.tag] || ''}`.trim() }),
      el('td', { text: fmtNum(r.userQuestions) }),
      el('td', { text: fmtNum(r.followUps) }),
      el('td', { text: fmtNum(r.otherAvgAnswerWords) }),
      el('td', { text: fmtNum(pct(r.userTalkShare), '%') }),
    ));
    block.replaceChildren(
      el('p', { class: 'st-hint', text: 'No clear trend yet. Here are your numbers so far.' }),
      el('table', { class: 'st-table' }, el('thead', {}, head), el('tbody', {}, ...rows)),
    );
  } else {
    block.replaceChildren(el('p', { class: 'st-hint', text: 'A trend shows up here after a few conversations.' }));
  }

  const step = mem.nextStep;
  const stepBox = $('next-step');
  if (step && step.status !== 'dismissed') {
    const prevStatus = stepBox.dataset.status;
    stepBox.dataset.status = `${step.id}:${step.status}`;
    const card = el('section', { class: 'st-step' },
      el('p', { class: 'st-step-head' },
        el('span', { text: 'This week, try' }),
        el('span', { class: `st-step-status ${step.status}`, text: STEP_STATUS[step.status] || step.status }),
      ),
      el('p', { class: 'st-step-text', text: step.text }),
    );
    if (prevStatus && prevStatus !== stepBox.dataset.status) card.classList.add('pop');
    stepBox.replaceChildren(card);
  } else {
    stepBox.replaceChildren();
    delete stepBox.dataset.status;
  }

  const convos = [...(mem.conversations || [])]
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, 6);
  if (!convos.length) {
    $('convos').replaceChildren(el('li', { class: 'st-empty-line', text: 'Nothing recorded yet.' }));
  } else {
    $('convos').replaceChildren(...convos.map((c) => {
      const sub = [el('span', { class: 'st-mini-tag', text: TAG_NAMES[c.tag] || c.tag })];
      if (c.seeded) sub.push(document.createTextNode(', sample'));
      if (c.note && c.note.status === 'dropped') sub.push(document.createTextNode(', counts only'));
      return el('li', { class: `st-convo${c.id === state.lastConvoId ? ' current' : ''}` },
        el('span', { class: 'st-convo-name', text: c.otherName || 'Someone' }),
        el('span', { class: 'st-convo-date', text: fmtDate(c.createdAt) }),
        el('span', { class: 'st-convo-sub' }, ...sub),
      );
    }));
  }
}

// ---------- data ----------

let memoryTimer = null;
function refreshMemory() {
  clearTimeout(memoryTimer);
  memoryTimer = setTimeout(async () => {
    try {
      state.memory = await getJson('/api/memory');
      for (const c of state.memory.conversations || []) {
        // Memory is a full snapshot; keep any live-only transcript we already have.
        if (!state.convos.has(c.id) || c.turns) state.convos.set(c.id, c);
      }
      if (state.view === 'memory') renderMemory();
    } catch { /* try again on the next memory event or reconnect */ }
  }, 120);
}

async function fetchConvo(id) {
  try {
    const c = await getJson(`/api/conversations/${encodeURIComponent(id)}`);
    const known = state.convos.get(id);
    // A WS update may have landed while we were waiting; don't step back in time.
    if (!known || !known.note || c.note) state.convos.set(id, c);
    if (state.convoId === id) render();
  } catch { /* deleted or server away; the WS will tell us */ }
}

function setFocus(view, conversationId) {
  if (!VIEWS.includes(view)) return;
  const prevView = state.view;
  state.view = view;
  state.convoId = conversationId || null;
  if (state.convoId) state.lastConvoId = state.convoId;
  if (view === 'recording' && state.convoId) startTimer(state.convoId);
  if (view !== 'recording' && state.convoId) stopTimer(state.convoId);
  if (view === 'start') state.pendingTagId = null;
  if (view === 'memory' && prevView !== 'memory') refreshMemory();
  if (state.convoId) {
    const c = state.convos.get(state.convoId);
    const needTurns = view !== 'recording' && (!c || !c.turns) && !state.doneTurns.has(state.convoId);
    if (!c || needTurns || (view === 'coaching' && !c.signals && !c.note)) fetchConvo(state.convoId);
  }
  render();
}

function settleProcessing(id) {
  const t = state.processing.get(id);
  if (t) clearTimeout(t);
  state.processing.delete(id);
}

function handle(msg) {
  const id = msg.conversationId;
  switch (msg.type) {
    case 'hello':
      state.mock = !!msg.mock;
      $('mock-badge').hidden = !state.mock;
      refreshMemory();
      if (msg.focus) setFocus(msg.focus.view, msg.focus.conversationId);
      else render();
      break;
    case 'focus':
      setFocus(msg.view, id);
      break;
    case 'conversation': {
      const c = msg.conversation;
      if (!c || !c.id) break;
      const prev = state.convos.get(c.id);
      // Keep the transcript if this update didn't carry one.
      if (prev && !c.turns && prev.turns) c.turns = prev.turns;
      state.convos.set(c.id, c);
      if (!c.turns && !c.signals && !c.note) state.pendingTagId = c.id;
      if (c.note || c.signals) settleProcessing(c.id);
      if (c.id === state.convoId || state.view === 'start') render();
      break;
    }
    case 'processing':
      if (!id) break;
      settleProcessing(id);
      state.processing.set(id, setTimeout(() => {
        state.processing.delete(id);
        if (id === state.convoId) render();
      }, PROCESSING_GIVE_UP_MS));
      // Coaching can take a few seconds live; get the room looking at it now
      // rather than waiting for the phone to switch.
      if (id === state.convoId && state.view === 'label') state.view = 'coaching';
      if (id === state.convoId) render();
      break;
    case 'partial':
    case 'turn': {
      if (!id) break;
      let m = state.live.get(id);
      if (!m) { m = new Map(); state.live.set(id, m); }
      if (msg.type === 'partial') {
        const prev = m.get(msg.turnId);
        if (prev && !prev.partial) break;
        m.set(msg.turnId, { speaker: msg.speaker || (prev && prev.speaker) || 'unknown', text: msg.text || '', partial: true });
      } else if (msg.turn) {
        m.set(msg.turn.turnId, { speaker: msg.turn.speaker, text: msg.turn.text, partial: false });
      }
      startTimer(id);
      // If the focus call got lost, the transcript arriving is proof enough.
      if (state.view === 'start' && (!state.convoId || state.convoId === id)) {
        setFocus('recording', id);
      } else if (id === state.convoId && (state.view === 'recording' || state.view === 'label')) {
        render();
      }
      break;
    }
    case 'done':
      if (!id) break;
      stopTimer(id);
      state.doneTurns.set(id, Array.isArray(msg.turns) ? msg.turns : turnsFor(id));
      if (id === state.convoId) render();
      break;
    case 'memory':
      refreshMemory();
      break;
    case 'deleted':
      if (!id) break;
      state.convos.delete(id);
      state.live.delete(id);
      state.doneTurns.delete(id);
      settleProcessing(id);
      if (state.memory) {
        state.memory.conversations = (state.memory.conversations || []).filter((c) => c.id !== id);
      }
      if (id === state.convoId && state.view !== 'memory') setFocus('start', null);
      else render();
      break;
    default:
      break;
  }
}

// ---------- socket ----------

let attempt = 0;
let pillTimer = null;

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  let ws;
  try {
    ws = new WebSocket(`${proto}://${location.host}/ws/stage`);
  } catch {
    scheduleReconnect();
    return;
  }
  ws.onopen = () => {
    attempt = 0;
    clearTimeout(pillTimer);
    pillTimer = null;
    $('conn-pill').hidden = true;
  };
  ws.onmessage = (e) => {
    if (typeof e.data !== 'string') return;
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    try { handle(msg); } catch (err) { console.error('stage message failed', msg.type, err); }
  };
  ws.onclose = () => scheduleReconnect();
  ws.onerror = () => { /* onclose follows */ };
}

function scheduleReconnect() {
  // Don't flash the pill for a blip; only once we've been down a moment.
  if (!pillTimer) pillTimer = setTimeout(() => { $('conn-pill').hidden = false; }, 1200);
  const delay = Math.min(10000, 500 * 2 ** attempt) * (0.75 + Math.random() * 0.5);
  attempt += 1;
  setTimeout(connect, delay);
}

// ---------- boot ----------

function init() {
  const theme = new URLSearchParams(location.search).get('theme');
  if (theme === 'dark' || theme === 'light') document.documentElement.dataset.theme = theme;

  getJson('/api/health')
    .then((h) => { state.mock = !!(h && h.mock); $('mock-badge').hidden = !state.mock; })
    .catch(() => {});
  refreshMemory();
  setInterval(() => { if (state.view === 'recording' || state.view === 'label') updateTimer(); }, 500);
  render();
  connect();
}

init();

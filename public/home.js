// Home. This is the team's Figma Make App.tsx rendered as plain DOM: same elements, same class
// names, same order, so home.css (the Figma's index.css) applies untouched. The only thing that
// changed is where the words come from: /api/memory instead of the hardcoded reflections, and
// /ws/stage for the recording card, since the phone does the actual recording.

const USER = { name: 'Parth', initials: 'PS' };
const MONTHS = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];
const FIGMA_GOALS = ['Ask one open question', 'Pause before replying', 'Reflect one detail'];
const FLAG_GOALS = {
  'cut-in': 'Let them finish before you talk',
  gossip: 'Leave stories about other people out',
  undersell: 'Say one real thing about what you do',
};
const EMBEDDED = window.self !== window.top;

// ---------- DOM helpers ----------

function el(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'disabled' || k === 'checked') node[k] = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids) if (kid != null && kid !== false) node.append(kid);
  return node;
}

// replaceChildren() would print a literal "false" for a skipped child; this drops them like el() does.
function fill(node, ...kids) {
  node.replaceChildren(...kids.filter((kid) => kid != null && kid !== false));
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs, ...kids) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  for (const kid of kids) node.append(kid);
  return node;
}

// <Logo /> from App.tsx
function logo(size = 36) {
  const p = (attrs) => svgEl('path', attrs);
  return svgEl('svg', { width: size, height: size * 0.62, viewBox: '0 0 56 35', fill: 'none', 'aria-hidden': 'true' },
    p({ d: 'M28 17.500C21 6 7 4 5 17.500c2 13.500 16 11.500 23 0Z', stroke: 'var(--accent)', 'stroke-width': '5.500', 'stroke-linejoin': 'round', opacity: '.55' }),
    p({ d: 'M28 17.500C35 6 49 4 51 17.500c-2 13.500-16 11.500-23 0Z', stroke: 'var(--accent)', 'stroke-width': '5.500', 'stroke-linejoin': 'round' }),
    p({ d: 'M20.500 18.500 27 13h5.500l4.500 3.500-3 5-6.500 4-3-2.500-3.500 1Z', fill: 'var(--paper)' }),
    p({ d: 'M22 17.500 27.500 13H32l3.500 3.500', stroke: 'var(--accent)', 'stroke-width': '2.200', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }),
    p({ d: 'm23 21.500 2.500 2.500M26 20l2.500 2.500M29 18.500l2.500 2.500', stroke: 'var(--accent)', 'stroke-width': '1.800', 'stroke-linecap': 'round' }),
  );
}

// <Icon /> from App.tsx
const ICON_PATHS = {
  spark: [['path', { d: 'm12 3-1.2 4.1a5.3 5.3 0 0 1-3.7 3.7L3 12l4.1 1.2a5.3 5.3 0 0 1 3.7 3.7L12 21l1.2-4.1a5.3 5.3 0 0 1 3.7-3.7L21 12l-4.1-1.2a5.3 5.3 0 0 1-3.7-3.7L12 3Z' }], ['path', { d: 'M5 3v4M3 5h4' }]],
  stop: [['rect', { x: '6', y: '6', width: '12', height: '12', rx: '1.5', fill: 'currentColor' }]],
  check: [['path', { d: 'm5 12 4 4L19 6', pathLength: '1' }]],
  arrow: [['path', { d: 'M5 12h14M13 6l6 6-6 6' }]],
  back: [['path', { d: 'M19 12H5M11 6l-6 6 6 6' }]],
  flame: [['path', { d: 'M12 3c1 3.5 4.5 5.5 4.5 9.5a4.5 4.5 0 0 1-9 0c0-2 1-3.2 2.2-4.3.1 1.6.9 2.3 1.6 2.3C11.800 8.500 11 6 12 3Z' }]],
  calendar: [['rect', { x: '3', y: '5', width: '18', height: '16', rx: '2' }], ['path', { d: 'M16 3v4M8 3v4M3 10h18' }]],
};
function icon(name, size = 18) {
  return svgEl('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' },
    ...ICON_PATHS[name].map(([tag, attrs]) => svgEl(tag, attrs)));
}

const kv = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* private mode */ } },
};
const readJson = (key, fallback) => { try { return JSON.parse(kv.get(key)) ?? fallback; } catch { return fallback; } };

// ---------- formatting ----------

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '');
const firstName = (name) => cap((name || 'them').trim().split(/\s+/)[0]);
const initialsOf = (name) => (name || 'them').trim().split(/\s+/).slice(0, 2).map((w) => w.charAt(0).toUpperCase()).join('');
const pad2 = (n) => String(n).padStart(2, '0');

function dayKey(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

const TODAY = new Date();
const TODAY_KEY = dayKey(TODAY);

function fmtTime(d) {
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

// "Today, 10:30 AM" / "Yesterday, 4:15 PM" / "Oct 20, 12:40 PM"
function fmtWhen(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const key = dayKey(d);
  const yesterday = new Date(TODAY); yesterday.setDate(TODAY.getDate() - 1);
  const day = key === TODAY_KEY ? 'Today' : key === dayKey(yesterday) ? 'Yesterday'
    : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${day}, ${fmtTime(d)}`;
}

// "0:04" for transcript lines, "14:32" for durations and the timer.
function fmtClock(ms, { padMinutes = false } = {}) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return `${padMinutes ? pad2(m) : m}:${pad2(s % 60)}`;
}

// "Saturday · Oct 25, 2026"
function heroDate(d) {
  return `${d.toLocaleDateString('en-US', { weekday: 'long' })} · ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
}

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'Good evening' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

// ---------- state ----------

const state = {
  memory: null,
  convos: [],            // newest first, shaped for the cards (see convoView)
  view: { year: TODAY.getFullYear(), month: TODAY.getMonth() },
  savedPop: false,
  logged: new Set(readJson('playback-logged-days', [])),
  checks: readJson('playback-home-checks', {}),
  modal: null,           // the convo whose follow-up is open
  rec: { active: false, id: null, name: null, startedAt: null, lastElapsed: 0, lines: new Map() },
};

const refs = {}; // long-lived nodes we update in place

// ---------- data shaping ----------

function convoView(c) {
  const turns = Array.isArray(c.turns) ? c.turns : [];
  const takeaways = (c.insight && Array.isArray(c.insight.takeaways)) ? c.insight.takeaways : [];
  const keep = takeaways.find((t) => t.kind === 'keep');
  const tryT = takeaways.find((t) => t.kind === 'try' && t.tryInstead);
  const note = c.note && c.note.text ? c.note : null;
  const last = turns[turns.length - 1];
  const awkward = c.hooks && c.hooks.awkward ? c.hooks.awkward : null;
  return {
    id: c.id,
    raw: c,
    name: cap(c.otherName || 'them'),
    first: firstName(c.otherName),
    initials: initialsOf(c.otherName),
    createdAt: c.createdAt,
    when: fmtWhen(c.createdAt),
    duration: last ? fmtClock(last.endMs || 0, { padMinutes: true }) : '00:00',
    summary: keep ? keep.text : note ? note.text : 'No reflection yet. Coaching lands here once the phone finishes.',
    next: tryT ? tryT.tryInstead : note && note.suggestion ? note.suggestion : 'Nothing to change yet.',
    followUp: c.followUp || null,
    commitments: c.hooks && Array.isArray(c.hooks.commitments) ? c.hooks.commitments : [],
    flags: awkward && Array.isArray(awkward.flags) ? awkward.flags : [],
    score: awkward && typeof awkward.score === 'number' ? awkward.score : null,
    userLabel: c.userLabel || null,
    transcript: turns.map((t) => [fmtClock(t.startMs || 0), t.speaker === c.userLabel ? 'me' : 'them', t.text || '']),
  };
}

function applyMemory(mem) {
  state.memory = mem;
  state.convos = [...(mem.conversations || [])]
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .map(convoView);
}

// Calendar colour per day: the worst awkward score of that day's conversations.
function dayStates() {
  const worst = new Map();
  for (const c of state.convos) {
    const d = new Date(c.createdAt);
    if (Number.isNaN(d.getTime())) continue;
    const key = dayKey(d);
    const score = c.score ?? 0;
    worst.set(key, Math.max(worst.get(key) ?? -1, score));
  }
  const states = new Map();
  for (const [key, score] of worst) states.set(key, score < 30 ? 'green' : score < 70 ? 'yellow' : 'red');
  return states;
}

function stateFor(key, states) {
  return states.get(key) || (state.logged.has(key) ? 'green' : '');
}

// buildMonth from App.tsx; Monday-first grid, days after today left plain.
function buildMonth(year, month, states) {
  const offset = (new Date(year, month, 1).getDay() + 6) % 7;
  const total = new Date(year, month + 1, 0).getDate();
  const cells = Math.ceil((offset + total) / 7) * 7;
  return Array.from({ length: cells }, (_, index) => {
    const day = index - offset + 1;
    if (day < 1 || day > total) return { day: '', state: '', key: null };
    const key = dayKey(new Date(year, month, day));
    if (key > TODAY_KEY) return { day, state: '', key };
    return { day, state: stateFor(key, states), key };
  });
}

function streak(states) {
  let n = 0;
  const d = new Date(TODAY);
  for (let i = 0; i < 400; i++) {
    if (!stateFor(dayKey(d), states)) break;
    n++;
    d.setDate(d.getDate() - 1);
  }
  return n;
}

function goals() {
  const out = [];
  const step = state.memory && state.memory.nextStep;
  if (step && step.text && step.status !== 'dismissed') out.push(step.text);
  const latest = state.convos[0];
  if (latest) {
    for (const f of latest.flags) {
      const text = FLAG_GOALS[f.kind];
      if (text && !out.includes(text)) out.push(text);
      if (out.length >= 3) break;
    }
  }
  for (const text of FIGMA_GOALS) { if (out.length >= 3) break; if (!out.includes(text)) out.push(text); }
  return out.slice(0, 3);
}

function tasks() {
  const out = [];
  for (const c of state.convos) {
    if (c.followUp && c.followUp.status === 'draft' && c.followUp.text) out.push({ key: `fu:${c.id}`, text: `Follow up with ${c.first}`, convo: c });
  }
  for (const c of state.convos) {
    for (const k of c.commitments) if (k && k.text) out.push({ key: `commit:${c.id}:${k.turnId ?? k.text}`, text: `You said: ${k.text}` });
  }
  return out;
}

function toggleCheck(key) {
  state.checks[key] = !state.checks[key];
  kv.set('playback-home-checks', JSON.stringify(state.checks));
}

// ---------- shell ----------

function header() {
  return el('header', { class: 'header' },
    el('div', { class: 'brand' }, el('span', { class: 'brand-mark' }, logo(38)), el('span', { text: 'Playback' })),
    el('div', { class: 'header-actions' }, el('button', { class: 'avatar', 'aria-label': 'Open your profile', text: USER.initials })),
  );
}

function parseHash() {
  const m = window.location.hash.match(/^#conversations(?:\/(\d+))?$/);
  if (!m) return -1;
  const n = m[1] ? Number(m[1]) : 0;
  return state.convos.length && n >= state.convos.length ? 0 : n;
}

function renderPage() {
  const index = parseHash();
  const home = index < 0;
  refs.shell.classList.toggle('with-wash', home);
  const main = home ? homePage() : transcriptPage(index);
  if (refs.main) refs.main.replaceWith(main); else refs.shell.append(main);
  refs.main = main;
  if (home) { renderCalendar(); renderGoals(); renderTasks(); renderRecording(); renderConversations(); }
}

// ---------- home ----------

function homePage() {
  refs.calendar = el('section', { class: 'card calendar-card' });
  refs.goals = el('section', { class: 'card list-card' });
  refs.tasks = el('section', { class: 'card list-card' });
  refs.recording = el('section', { class: 'card recording-card is-idle' });
  refs.conversations = el('section', { class: 'card conversations-card' });
  refs.live = el('div', { class: 'live-transcript idle', role: 'log', 'aria-live': 'polite', 'aria-label': 'Live transcription' });
  return el('main', { class: 'workspace' },
    el('div', { class: 'page-intro hero-intro' },
      el('span', { class: 'cloud c1', 'aria-hidden': 'true' }), el('span', { class: 'cloud c2', 'aria-hidden': 'true' }), el('span', { class: 'cloud c3', 'aria-hidden': 'true' }),
      el('div', { class: 'hero-copy' },
        el('span', { class: 'hero-date', text: heroDate(TODAY) }),
        el('span', { class: 'label', text: 'OVERVIEW' }),
        el('h1', { text: `${greeting()}, ${USER.name}` }),
        el('p', { class: 'intro-subtitle', text: 'Review your practice and recent conversations.' }),
      ),
    ),
    el('div', { class: 'dashboard' },
      el('aside', { class: 'planner' }, refs.calendar, refs.goals, refs.tasks),
      el('div', { class: 'activity' }, refs.recording, refs.conversations),
    ),
  );
}

function shiftMonth(delta) {
  const d = new Date(state.view.year, state.view.month + delta, 1);
  state.view = { year: d.getFullYear(), month: d.getMonth() };
  renderCalendar();
}

function logToday() {
  state.logged.add(TODAY_KEY);
  kv.set('playback-logged-days', JSON.stringify([...state.logged]));
  state.savedPop = true;
  renderCalendar();
  window.setTimeout(() => { state.savedPop = false; renderCalendar(); }, 900);
}

function renderCalendar() {
  if (!refs.calendar) return;
  const { year, month } = state.view;
  const states = dayStates();
  const atCurrent = year === TODAY.getFullYear() && month === TODAY.getMonth();
  const todayState = stateFor(TODAY_KEY, states);
  const n = streak(states);
  const cells = buildMonth(year, month, states);
  fill(refs.calendar,
    el('div', { class: 'section-heading' },
      el('div', {}, el('span', { class: 'label', text: `${MONTHS[month]} ${year}` }), el('h2', { text: 'Your calendar' })),
      el('div', { class: 'month-nav' },
        el('button', { 'aria-label': 'Previous month', onclick: () => shiftMonth(-1) }, icon('back', 14)),
        el('button', { 'aria-label': 'Next month', disabled: atCurrent, onclick: () => shiftMonth(1) }, icon('arrow', 14)),
      ),
    ),
    atCurrent && el('div', { class: 'streak-row' },
      el('span', { class: 'streak' }, icon('flame', 13), n > 0 ? `${n}-day practice streak` : 'Start a streak today'),
      !todayState && el('button', { class: 'log-today', onclick: logToday, text: 'Log today' }),
    ),
    el('div', { class: 'weekdays' }, ...['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d) => el('span', { text: d }))),
    el('div', { class: 'month-grid' }, ...cells.map((c) => {
      const isToday = atCurrent && c.key === TODAY_KEY;
      const cls = `${c.state}${isToday ? ' today' : ''}${state.savedPop && isToday ? ' saved' : ''}`;
      return el('span', { class: cls || null, text: c.day === '' ? '' : String(c.day) });
    })),
    el('div', { class: 'calendar-key' },
      el('span', {}, el('i', { class: 'key-green' }), 'Went well'),
      el('span', {}, el('i', { class: 'key-yellow' }), 'A few bumps'),
      el('span', {}, el('i', { class: 'key-red' }), 'Rough one'),
    ),
  );
}

function progress(label, done, total) {
  const pct = total ? (done / total) * 100 : 0;
  const bar = el('i');
  bar.style.width = `${pct}%`;
  return el('div', { class: 'progress', role: 'progressbar', 'aria-label': label, 'aria-valuemin': '0', 'aria-valuemax': String(total), 'aria-valuenow': String(done), 'aria-valuetext': `${done} of ${total} done` }, bar);
}

function checkRow(key, text, onToggle) {
  const on = !!state.checks[key];
  return el('button', { class: `check-row ${on ? 'completed' : ''}`, onclick: () => { toggleCheck(key); onToggle(); } },
    el('span', { class: 'checkbox' }, on ? icon('check', 13) : null), el('span', { text }));
}

function renderGoals() {
  if (!refs.goals) return;
  const list = goals();
  const done = list.filter((t) => state.checks[t]).length;
  fill(refs.goals,
    el('div', { class: 'list-title' }, el('div', {}, el('span', { class: 'label', text: 'YOUR FOCUS' }), el('h2', { text: 'Goals' }))),
    progress('Goals completed', done, list.length),
    ...list.map((text) => checkRow(text, text, renderGoals)),
  );
}

function renderTasks() {
  if (!refs.tasks) return;
  const list = tasks();
  const done = list.filter((t) => state.checks[t.key]).length;
  fill(refs.tasks,
    el('div', { class: 'list-title' }, el('div', {}, el('span', { class: 'label', text: 'UP NEXT' }), el('h2', { text: 'Pending tasks' }))),
    progress('Tasks completed', done, list.length),
    ...(list.length ? list.map((t) => el('div', { class: 'task-row' },
      checkRow(t.key, t.text, renderTasks),
      t.convo && el('button', { class: 'followup-btn', onclick: () => openFollowUp(t.convo) }, icon('spark', 13), ' Write me a follow up'),
    )) : [el('p', { class: 'empty-row', text: 'Nothing waiting on you.' })]),
  );
}

// ---------- recording card ----------

function recName() {
  const r = state.rec;
  if (r.name) return firstName(r.name);
  const known = state.convos.find((c) => c.id === r.id);
  return known ? known.first : null;
}

function renderRecording() {
  if (!refs.recording) return;
  const r = state.rec;
  const name = recName();
  refs.recording.className = `card recording-card ${r.active ? 'is-recording' : 'is-idle'}`;
  refs.time = el('time', { text: fmtClock(r.active && r.startedAt ? Date.now() - r.startedAt : r.lastElapsed, { padMinutes: true }) });
  fill(refs.recording,
    el('div', { class: 'recording-top' },
      el('div', {},
        el('div', { class: 'live-label' },
          el('span', { class: r.active ? 'pulse' : 'quiet-dot' }),
          r.active && el('span', { class: 'rec-tag', text: 'REC' }),
          r.active ? 'Recording in progress' : 'Not recording'),
        el('h2', { text: r.active ? (name ? `Session with ${name}` : 'Session in progress') : 'Ready when you are' }),
      ),
      r.active && el('button', { class: 'button stop-button', disabled: true, text: 'Recording on your phone' }),
    ),
    !r.active && el('div', { class: 'consent-step static' },
      el('span', {}, el('strong', { text: 'Start on your phone.' }), ' Tell them you’re recording before you tap Record.')),
    refs.live,
    el('div', { class: 'recording-meta' },
      el('span', { class: 'elapsed' }, refs.time, ' ', el('small', { text: 'elapsed' })),
      r.active && name && el('span', { class: 'consent-ok' }, icon('check', 13), ` ${name} agreed to be recorded`),
      el('span', { class: 'private-note', text: 'Private to you' }),
    ),
  );
  renderLive();
}

// The LiveTranscript. Lines are kept rather than rebuilt so card-in only plays for new ones
// and the caret sits on whichever line the phone is still filling in.
function renderLive() {
  const box = refs.live;
  if (!box) return;
  const r = state.rec;
  box.classList.toggle('idle', !r.active);
  if (!r.active) {
    box.replaceChildren(el('p', { class: 'live-empty', text: 'Live transcription will appear here once the session starts.' }));
    return;
  }
  box.querySelector('.live-empty')?.remove();
  const known = state.convos.find((c) => c.id === r.id);
  const userLabel = known ? known.userLabel : null;
  const name = recName() || 'Them';
  const ordered = [...r.lines.entries()].sort((a, b) => a[0] - b[0]);
  for (const [turnId, t] of ordered) {
    let line = box.querySelector(`[data-turn="${turnId}"]`);
    const who = userLabel ? (t.speaker === userLabel ? 'me' : 'them') : 'them';
    const whoText = userLabel ? (who === 'me' ? 'You' : name) : (t.speaker && t.speaker !== 'unknown' ? t.speaker : '');
    if (!line) {
      line = el('div', { class: `line ${who}`, 'data-turn': String(turnId) },
        el('span', { class: 'line-time', text: fmtClock(t.at - r.startedAt) }),
        el('span', { class: 'line-who', text: whoText }),
        el('p', {}, el('span', { class: 'said' }), el('span', { class: 'caret' })));
      box.append(line);
    }
    line.className = `line ${who}`;
    line.querySelector('.line-who').textContent = whoText;
    line.querySelector('.said').textContent = t.text || '';
    line.querySelector('.caret').hidden = !t.partial;
  }
  // The phone can stop sending a turn id; drop lines that no longer exist.
  for (const line of box.querySelectorAll('[data-turn]')) if (!r.lines.has(Number(line.dataset.turn))) line.remove();
  box.scrollTo({ top: box.scrollHeight, behavior: 'smooth' });
}

function startRec(id, name) {
  const r = state.rec;
  if (r.active && r.id === id) {
    if (name && r.name !== name) { r.name = name; renderRecording(); }
    return;
  }
  state.rec = { active: true, id, name: name || null, startedAt: Date.now(), lastElapsed: r.lastElapsed, lines: new Map() };
  renderRecording();
}

function stopRec() {
  const r = state.rec;
  if (!r.active) return;
  r.active = false;
  // Only a session that actually produced lines counts as finished; a focus blip (or a reload
  // mid-recording followed by the phone going back to start) keeps the previous duration.
  if (r.lines.size && r.startedAt) r.lastElapsed = Date.now() - r.startedAt;
  r.lines = new Map();
  renderRecording();
}

function tick() {
  const r = state.rec;
  if (r.active && refs.time && r.startedAt) refs.time.textContent = fmtClock(Date.now() - r.startedAt, { padMinutes: true });
}

// ---------- conversations ----------

function reflectionCopy(c, extraClass = '') {
  return el('div', { class: `reflection-copy ${extraClass}`.trim() },
    el('div', {}, el('h4', { text: 'What worked well' }), el('p', { text: c.summary })),
    el('div', {}, el('h4', { text: 'What I’ll do next time' }), el('p', { text: c.next })),
  );
}

function renderConversations() {
  if (!refs.conversations) return;
  fill(refs.conversations,
    el('div', { class: 'section-heading conversations-heading' },
      el('div', {}, el('span', { class: 'label', text: 'REFLECTIONS' }), el('h2', { text: 'Recent conversations' }))),
    el('div', { class: 'conversation-scroll' },
      ...(state.convos.length ? state.convos.map((c, i) => el('article', { class: 'conversation' },
        el('div', { class: 'person-row' },
          el('span', { class: 'person-avatar', text: c.initials }),
          el('div', {}, el('h3', { text: c.name }), el('span', { text: c.when })),
          el('button', { class: 'deck-chip', 'aria-label': `View full conversation with ${c.name}`, onclick: () => { window.location.hash = `conversations/${i}`; } }, 'View full ', icon('arrow', 14)),
        ),
        reflectionCopy(c),
      )) : [el('p', { class: 'empty-row', text: state.memory ? 'No conversations yet. Record one on your phone.' : 'Loading your conversations…' })]),
    ),
  );
}

// ---------- transcript page ----------

function openReplay(id) {
  if (EMBEDDED) window.parent.postMessage({ type: 'playback:open-replay', id }, location.origin);
  else window.location.href = `replay.html?id=${encodeURIComponent(id)}`;
}

function transcriptPage(index) {
  const c = state.convos[index];
  return el('main', { class: 'workspace' },
    el('button', { class: 'back-link', onclick: () => { window.location.hash = ''; } }, icon('back', 15), ' Back to overview'),
    el('div', { class: 'page-intro' },
      el('div', {}, el('h1', { text: c ? `Conversation with ${c.first}` : 'Conversation' }), el('p', { class: 'intro-subtitle', text: 'Full transcript and reflection.' }))),
    el('div', { class: 'transcripts' },
      c && el('article', { class: 'transcript', id: `conv-${index}` },
        el('div', { class: 'person-row' },
          el('span', { class: 'person-avatar', text: c.initials }),
          el('div', {}, el('h3', { text: c.name }), el('span', { text: `${c.when} · ${c.duration}` })),
          el('button', { class: 'view-all', onclick: () => openReplay(c.id) }, 'Open replay ', icon('arrow', 14)),
        ),
        el('div', { class: 'transcript-lines' }, ...c.transcript.map(([time, who, text]) => el('div', { class: `line ${who}` },
          el('span', { class: 'line-time', text: time }),
          el('span', { class: 'line-who', text: who === 'me' ? 'You' : c.first }),
          el('p', { text }),
        ))),
        reflectionCopy(c, 'transcript-reflection'),
      ),
    ),
  );
}

// ---------- follow-up modal ----------

function closeFollowUp() {
  state.modal = null;
  refs.modal?.remove();
  refs.modal = null;
}

function openFollowUp(c) {
  closeFollowUp();
  state.modal = c;
  const textarea = el('textarea', { class: 'followup-text', rows: '9' });
  textarea.value = c.followUp.text;
  const copyBtn = el('button', { class: 'button', text: 'Copy message', onclick: () => { navigator.clipboard?.writeText(textarea.value); copyBtn.textContent = 'Copied'; } });
  const sentBtn = el('button', { class: 'button secondary', text: 'Mark sent', onclick: async () => {
    sentBtn.disabled = true;
    try {
      const res = await fetch(`/api/conversations/${encodeURIComponent(c.id)}/follow-up/sent`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: textarea.value }) });
      if (!res.ok) throw new Error(String(res.status));
      closeFollowUp();
      refreshMemory();
    } catch {
      sentBtn.disabled = false;
      sentBtn.textContent = 'Couldn’t mark it. Try again';
    }
  } });
  refs.modal = el('div', { class: 'modal-backdrop', onclick: closeFollowUp },
    el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'followup-title', onclick: (e) => e.stopPropagation() },
      el('div', { class: 'modal-head' },
        el('div', {}, el('span', { class: 'label', text: `DRAFT FOR ${c.first.toUpperCase()}` }), el('h2', { id: 'followup-title', text: 'Follow-up message' })),
        el('button', { class: 'modal-close', 'aria-label': 'Close', text: '×', onclick: closeFollowUp }),
      ),
      el('p', { class: 'modal-note', text: `Based on your conversation on ${c.when}. Edit it before you send.` }),
      textarea,
      el('div', { class: 'modal-actions' },
        el('button', { class: 'button ghost', text: 'Close', onclick: closeFollowUp }),
        copyBtn,
        sentBtn,
      ),
    ),
  );
  refs.shell.append(refs.modal);
  textarea.focus();
}

// ---------- data ----------

async function getJson(path) {
  const res = await fetch(path, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${path} ${res.status}`);
  return res.json();
}

let memoryTimer = null;
function refreshMemory() {
  clearTimeout(memoryTimer);
  memoryTimer = setTimeout(async () => {
    try {
      applyMemory(await getJson('/api/memory'));
    } catch {
      if (!state.memory) applyMemory({ conversations: [] });
    }
    // Everything on screen reads from state.convos, so redraw whichever page is up.
    if (parseHash() >= 0) renderPage();
    else { renderCalendar(); renderGoals(); renderTasks(); renderConversations(); renderRecording(); }
    if (state.modal) {
      const still = state.convos.find((c) => c.id === state.modal.id);
      if (!still || !still.followUp || still.followUp.status !== 'draft') closeFollowUp();
    }
  }, 120);
}

// ---------- /ws/stage ----------

function handle(msg) {
  const id = msg.conversationId;
  switch (msg.type) {
    case 'hello':
      if (msg.focus && msg.focus.view === 'recording' && msg.focus.conversationId) startRec(msg.focus.conversationId, msg.focus.otherName);
      else stopRec();
      break;
    case 'focus':
      if (msg.view === 'recording' && id) startRec(id, msg.otherName);
      else stopRec();
      break;
    case 'partial':
    case 'turn': {
      if (!id) break;
      startRec(id, state.rec.id === id ? state.rec.name : null);
      const lines = state.rec.lines;
      if (msg.type === 'partial') {
        const prev = lines.get(msg.turnId);
        if (prev && !prev.partial) break;
        lines.set(msg.turnId, { speaker: msg.speaker || (prev && prev.speaker) || null, text: msg.text || '', partial: true, at: prev ? prev.at : Date.now() });
      } else if (msg.turn) {
        const prev = lines.get(msg.turn.turnId);
        lines.set(msg.turn.turnId, { speaker: msg.turn.speaker, text: msg.turn.text, partial: false, at: prev ? prev.at : Date.now() });
      }
      renderLive();
      break;
    }
    case 'done':
      if (id && state.rec.id === id) stopRec();
      break;
    case 'conversation':
      if (msg.conversation && state.rec.active && msg.conversation.id === state.rec.id && msg.conversation.otherName) startRec(state.rec.id, msg.conversation.otherName);
      refreshMemory();
      break;
    case 'memory':
    case 'deleted':
      refreshMemory();
      break;
    default:
      break;
  }
}

let attempt = 0;
function connect() {
  let ws;
  try {
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/stage`);
  } catch {
    scheduleReconnect();
    return;
  }
  ws.onopen = () => { attempt = 0; };
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
  const delay = Math.min(10000, 500 * 2 ** attempt) * (0.75 + Math.random() * 0.5);
  attempt += 1;
  setTimeout(connect, delay);
}

// ---------- boot ----------

function init() {
  const theme = new URLSearchParams(location.search).get('theme');
  if (theme === 'dark' || theme === 'light') document.documentElement.dataset.theme = theme;
  if (EMBEDDED) document.body.classList.add('embedded');

  refs.shell = el('div', { class: 'app-shell with-wash' }, header());
  document.getElementById('root').append(refs.shell);
  renderPage();

  window.addEventListener('hashchange', () => { closeFollowUp(); renderPage(); window.scrollTo(0, 0); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.modal) closeFollowUp(); });
  setInterval(tick, 500);
  refreshMemory();
  connect();
}

init();

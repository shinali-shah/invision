// Home. This is the team's Figma Make App.tsx (v2: night / paper / marigold) rendered as plain DOM:
// same elements, same class names, same order, so home.css (the Figma's index.css) applies
// untouched. The only thing that changed is where the words come from: /api/memory instead of the
// hardcoded reflections, /ws/stage for the recording card (the phone does the actual recording),
// and /api/conversations/:id/{heatmap,compare} for the transcript page.

// Filled in from /api/me (USER_NAME on the server); these are the fallback until it answers.
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

// <Logo /> from App.tsx. The Figma ships it as a PNG (a gold infinity with a handshake at the
// crossing); this is the same mark drawn by hand so it scales and needs no asset. studio.html
// carries the identical markup.
function logoSvg(width = 56) {
  const p = (attrs) => svgEl('path', attrs);
  return svgEl('svg', { width, height: width * 0.43, viewBox: '0 0 56 24', fill: 'none', 'aria-hidden': 'true' },
    p({ d: 'M28 12C23.2 5 17.6 3 11.5 3 6 3 3 7 3 12s3 9 8.5 9c6.1 0 11.7-2 16.5-9 4.8-7 10.4-9 16.5-9 5.5 0 8.5 4 8.5 9s-3 9-8.5 9c-6.1 0-11.7-2-16.5-9Z', stroke: '#f4a51c', 'stroke-width': '4.6', 'stroke-linejoin': 'round' }),
    p({ d: 'M21.6 15.4l5-4.4 3.6.3 3.2 2.5-2.3 3.5-3.7 2.3-3.5-1.2Z', fill: '#c4820f' }),
    p({ d: 'M26.4 10.7l4.3-3.3 3.6.6 1.9 2.5-2.6 3-3.4-.5Z', fill: '#ffc650' }),
    p({ d: 'M24.7 17.1l1.5 1.4M26.5 15.7l1.6 1.5M28.3 14.3l1.6 1.4', stroke: '#7a4f03', 'stroke-width': '.9', 'stroke-linecap': 'round' }),
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

// Whole code points: charAt(0) on an emoji name gives half a surrogate pair.
const firstChar = (s) => (s ? Array.from(s)[0] : '');
const cap = (s) => (s ? firstChar(s).toUpperCase() + s.slice(firstChar(s).length) : '');
const cleanName = (name) => (name || '').trim() || 'them';
const firstName = (name) => cap(cleanName(name).split(/\s+/)[0]);
const initialsOf = (name) => cleanName(name).split(/\s+/).slice(0, 2).map((w) => firstChar(w).toUpperCase()).join('');
const pad2 = (n) => String(n).padStart(2, '0');

function dayKey(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// Read fresh each time: the Mac stays open overnight and "today" has to move with it.
const today = () => new Date();
const todayKey = () => dayKey(today());

function fmtTime(d) {
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

// "Today, 10:30 AM" / "Yesterday, 4:15 PM" / "Oct 20, 12:40 PM"
function fmtWhen(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const key = dayKey(d);
  const now = today();
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  const day = key === dayKey(now) ? 'Today' : key === dayKey(yesterday) ? 'Yesterday'
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
  view: { year: today().getFullYear(), month: today().getMonth() },
  dayShown: todayKey(),  // the day the page was last drawn for
  savedPop: false,
  logged: new Set(readJson('playback-logged-days', [])),
  checks: readJson('playback-home-checks', {}),
  modal: null,           // the convo whose follow-up is open
  rec: { active: false, id: null, name: null, startedAt: null, lastElapsed: 0, lines: new Map() },
  doneId: null,          // last conversation the hub said `done` for; its late turns don't restart the card
  who: '',               // "Before: who are you about to talk to?"
  extras: new Map(),     // conversation id -> { heat, compare } once fetched for the transcript page
  confirming: false,     // the delete confirm row on the transcript page
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
    needsLabel: !!c.needsLabel, // recorded, two voices, nobody tapped theirs: nothing coached yet
    turns,
    transcript: turns.map((t) => [fmtClock(t.startMs || 0), t.speaker === c.userLabel ? 'me' : 'them', t.text || '', t.turnId, t.speaker]),
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
  const todayK = todayKey();
  return Array.from({ length: cells }, (_, index) => {
    const day = index - offset + 1;
    if (day < 1 || day > total) return { day: '', state: '', key: null };
    const key = dayKey(new Date(year, month, day));
    if (key > todayK) return { day, state: '', key };
    return { day, state: stateFor(key, states), key };
  });
}

// Today doesn't break the streak until it's over: with nothing yet today, count back from yesterday.
function streak(states) {
  let n = 0;
  const d = today();
  if (!stateFor(dayKey(d), states)) d.setDate(d.getDate() - 1);
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

// Follow-ups and promises from older conversations have gone stale; the list only nags about recent ones.
const TASK_DAYS = 4;

function tasks() {
  const out = [];
  const since = today();
  since.setDate(since.getDate() - (TASK_DAYS - 1));
  since.setHours(0, 0, 0, 0);
  const recent = state.convos.filter((c) => new Date(c.createdAt) >= since);
  // Unfinished first: nothing else about that conversation exists until it's done.
  for (const c of state.convos) {
    if (c.needsLabel) out.push({ key: `label:${c.id}`, text: `Finish coaching for ${c.first}`, convo: c, finish: true });
  }
  for (const c of recent) {
    if (c.followUp && c.followUp.status === 'draft' && c.followUp.text) out.push({ key: `fu:${c.id}`, text: `Follow up with ${c.first}`, convo: c });
  }
  for (const c of recent) {
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
    el('div', { class: 'brand' }, el('span', { class: 'brand-mark' }, logoSvg(56)), el('span', { text: 'Playback' })),
    el('div', { class: 'header-actions' }, el('button', { class: 'avatar', 'aria-label': 'Open your profile', text: USER.initials })),
  );
}

// #conversations/<id> opens one transcript. The list is newest first, so a bare index would
// point at someone else as soon as a new conversation lands; a number is still accepted.
function parseHash() {
  const m = window.location.hash.match(/^#conversations(?:\/([^/]+))?$/);
  if (!m) return -1;
  if (!m[1]) return 0;
  const byId = state.convos.findIndex((c) => c.id === m[1]);
  if (byId >= 0) return byId;
  const n = /^\d+$/.test(m[1]) ? Number(m[1]) : 0;
  return state.convos.length && n >= state.convos.length ? 0 : n;
}

function renderPage() {
  const index = parseHash();
  const home = index < 0;
  refs.shell.classList.toggle('with-wash', home);
  const main = home ? homePage() : transcriptPage(index);
  if (refs.main) refs.main.replaceWith(main); else refs.shell.append(main);
  refs.main = main;
  if (home) { renderCalendar(); renderGoals(); renderTasks(); renderRecording(); renderConversations(); fitHeroLine(); }
}

// The Figma's clamp() sizes the greeting for "ALEX" at 160px; "PARTH" or "GOOD AFTERNOON" wrap.
// Shrink until it sits on one line, down to a floor, and re-fit when the width or the fonts change.
function fitHeroLine() {
  const h1 = refs.heroH1;
  if (!h1 || !h1.isConnected) return;
  const box = h1.parentElement.clientWidth;
  if (!box) return;
  h1.style.fontSize = '';
  h1.style.whiteSpace = 'nowrap';
  let size = parseFloat(getComputedStyle(h1).fontSize);
  while (size > 56 && h1.scrollWidth > box) {
    size -= 4;
    h1.style.fontSize = `${size}px`;
  }
  if (h1.scrollWidth > box) h1.style.whiteSpace = ''; // a very long name still wraps rather than overflowing
}
let fitTimer = null;
window.addEventListener('resize', () => { clearTimeout(fitTimer); fitTimer = setTimeout(fitHeroLine, 120); });
if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitHeroLine);

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
        el('span', { class: 'hero-date', text: heroDate(today()) }),
        el('span', { class: 'label', text: 'OVERVIEW' }),
        (refs.heroH1 = el('h1', { text: `${greeting()}, ${USER.name}` })),
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
  state.logged.add(todayKey());
  kv.set('playback-logged-days', JSON.stringify([...state.logged]));
  state.savedPop = true;
  renderCalendar();
  window.setTimeout(() => { state.savedPop = false; renderCalendar(); }, 900);
}

function renderCalendar() {
  if (!refs.calendar) return;
  const { year, month } = state.view;
  const states = dayStates();
  const now = today();
  const todayK = dayKey(now);
  const atCurrent = year === now.getFullYear() && month === now.getMonth();
  const todayState = stateFor(todayK, states);
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
      const isToday = atCurrent && c.key === todayK;
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
    // A few weeks of promises is a long list; it scrolls inside the card rather than stretching the page.
    list.length ? el('div', { class: 'task-scroll' }, ...list.map((t) => el('div', { class: 'task-row' },
      checkRow(t.key, t.text, renderTasks),
      t.finish ? finishButton(t.convo)
        : t.convo && el('button', { class: 'followup-btn', onclick: () => openFollowUp(t.convo) }, icon('spark', 13), ' Write me a follow up'),
    ))) : el('p', { class: 'empty-row', text: 'Nothing waiting on you.' }),
  );
}

// ---------- recording card ----------

function recName() {
  const r = state.rec;
  if (r.name) return firstName(r.name);
  const known = state.convos.find((c) => c.id === r.id);
  return known ? known.first : null;
}

// The pre-call brief: what memory holds on whoever they're about to talk to, by first name.
function briefFor(name) {
  const key = name.trim().toLowerCase();
  if (!key) return null;
  // The one being recorded right now is the newest with this name and has nothing in it yet.
  const past = state.convos.filter((c) => c.first.toLowerCase() === key && c.id !== state.rec.id);
  if (!past.length) return { known: false };
  const hooks = (past.find((c) => c.raw.hooks) || past[0]).raw.hooks || {};
  const promise = (hooks.commitments || []).find((k) => k && k.text);
  const event = (hooks.events || []).find((e) => e && e.text);
  const topics = (hooks.topics || []).map((t) => t && t.term).filter(Boolean).slice(0, 2);
  return {
    known: true,
    promises: promise ? `You said: ${promise.text}` : 'Nothing you owe them.',
    upcoming: event ? event.text : 'Nothing they mentioned.',
    lit: topics.length ? `They kept coming back to ${topics.join(' and ')}.` : past[0].summary,
  };
}

// Idle: whoever was typed into the card. Recording: whoever the phone heard, once there is history.
function renderBrief() {
  if (!refs.brief) return;
  const r = state.rec;
  const who = r.active ? (recName() || '') : state.who;
  const name = who.trim() ? firstName(who) : 'them';
  let b = briefFor(who);
  if (r.active && b && !b.known) b = null;
  refs.brief.hidden = !b;
  if (!b) { refs.brief.replaceChildren(); return; }
  refs.brief.setAttribute('aria-label', `Brief for ${name}`);
  fill(refs.brief,
    ...(b.known ? [
      el('div', {}, el('h4', { text: 'Promises you made' }), el('p', { text: b.promises })),
      el('div', {}, el('h4', { text: 'Coming up for them' }), el('p', { text: b.upcoming })),
      el('div', {}, el('h4', { text: 'Last time' }), el('p', { text: b.lit })),
    ] : [el('p', { class: 'brief-empty', text: `No history with ${name} yet. This will be your first conversation, so the brief fills in afterwards.` })]),
  );
}

function renderRecording() {
  if (!refs.recording) return;
  const r = state.rec;
  const name = recName();
  refs.recording.className = `card recording-card ${r.active ? 'is-recording' : 'is-idle'}`;
  refs.time = el('time', { text: fmtClock(r.active && r.startedAt ? Date.now() - r.startedAt : r.lastElapsed, { padMinutes: true }) });
  refs.brief = el('div', { class: 'brief' });
  fill(refs.recording,
    el('div', { class: 'recording-top' },
      el('div', {},
        el('div', { class: 'live-label' },
          el('span', { class: r.active ? 'pulse' : 'quiet-dot' }),
          r.active && el('span', { class: 'rec-tag', text: 'REC' }),
          !r.active && 'Not recording'),
        el('h2', { text: r.active ? (name ? `Session with ${name}` : 'Session in progress') : 'Ready when you are' }),
      ),
      // The phone holds the mic, so these are status, not controls.
      r.active
        ? el('button', { class: 'button stop-button', disabled: true }, icon('stop', 16), ' Recording on your phone')
        : el('button', { class: 'button', disabled: true }, 'Start on your phone ', icon('arrow', 16)),
    ),
    // Nobody types a name before a conversation: the transcript names it, and the brief follows.
    !r.active && el('div', { class: 'before' },
      el('div', { class: 'before-row' },
        el('div', { class: 'who-field' },
          el('span', { class: 'label', text: 'Who you’re with' }),
          el('p', { class: 'who-auto', text: 'Picked up from the conversation. When a name is heard, what you owe them and what’s coming up for them appears here.' }),
        ),
      ),
      refs.brief,
    ),
    !r.active && el('div', { class: 'consent-step static' },
      el('span', {}, el('strong', { text: 'Start on your phone.' }), ' Tell them you’re recording, then just talk.')),
    refs.live,
    r.active && refs.brief,
    el('div', { class: 'recording-meta' },
      el('span', { class: 'elapsed' }, refs.time, ' ', el('small', { text: 'elapsed' })),
      r.active && name && el('span', { class: 'consent-ok' }, icon('check', 13), ` ${name} knows you’re recording`),
      el('span', { class: 'private-note', text: 'Private to you' }),
    ),
  );
  renderBrief();
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

// Finished turns carry transcript time. After a reload mid-recording our clock started at the
// reload, so the first turn that arrives pulls it back to where the session really began. One
// shot only: turns flushed at stop carry times from the whole session, not from now.
function syncStart(turn) {
  const r = state.rec;
  if (!r.active || !r.syncPending || !turn || !(turn.endMs > 0)) return;
  r.syncPending = false;
  const impliedStart = Date.now() - turn.endMs;
  if (impliedStart < r.startedAt) r.startedAt = impliedStart;
}

function tick() {
  const r = state.rec;
  if (r.active && refs.time && r.startedAt) refs.time.textContent = fmtClock(Date.now() - r.startedAt, { padMinutes: true });
  // Midnight: the ring, the hero date and "Today" labels all move on.
  const key = todayKey();
  if (key !== state.dayShown) {
    const [y, m] = state.dayShown.split('-').map(Number);
    state.dayShown = key;
    // Still on what was the current month? Follow the calendar into the new one.
    const now = today();
    if (state.view.year === y && state.view.month === m - 1) state.view = { year: now.getFullYear(), month: now.getMonth() };
    if (state.memory) applyMemory(state.memory); // "Today, 11:03 PM" is baked into each card view
    renderPage();
  }
}

// ---------- conversations ----------

function finishButton(c) {
  return el('button', { class: 'followup-btn finish-btn', onclick: () => openReplay(c.id) }, 'Finish on Replay ', icon('arrow', 13));
}

// Where the two reflection columns would go when nothing has been coached yet.
function uncoachedCopy(c, extraClass = '') {
  return el('div', { class: `uncoached ${extraClass}`.trim() },
    el('span', { class: 'uncoached-dot', 'aria-hidden': 'true' }),
    el('p', { text: 'Not coached yet: tap which voice is yours' }),
    finishButton(c),
  );
}

function reflectionCopy(c, extraClass = '') {
  if (c.needsLabel) return uncoachedCopy(c, extraClass);
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
      ...(state.convos.length ? state.convos.map((c) => el('article', { class: 'conversation' },
        el('div', { class: 'person-row' },
          el('span', { class: 'person-avatar', text: c.initials }),
          el('div', {}, el('h3', { text: c.name }), el('span', { text: c.when })),
          el('button', { class: 'deck-chip', 'aria-label': `View full conversation with ${c.name}`, onclick: () => { window.location.hash = `conversations/${c.id}`; } }, 'View full ', icon('arrow', 14)),
        ),
        reflectionCopy(c),
      )) : [el('p', { class: 'empty-convs', text: state.memory ? 'No conversations yet. Record one on your phone and it shows up here.' : 'Loading your conversations…' })]),
    ),
  );
}

// ---------- transcript page ----------

function openReplay(id) {
  if (EMBEDDED) window.parent.postMessage({ type: 'playback:open-replay', id }, location.origin);
  else window.location.href = `replay.html?id=${encodeURIComponent(id)}`;
}

// The Figma's `analyses` entry, computed from what the pipeline stored on the conversation.
function analysis(c) {
  const raw = c.raw;
  const signals = raw.signals || {};
  const hooks = raw.hooks || {};
  const behavior = raw.behavior || null;
  const followUps = new Set((signals.questions || []).filter((q) => q.isFollowUp).map((q) => q.turnId));
  if (!followUps.size) for (const d of hooks.followUpDetector || []) if (d.isFollowUp) followUps.add(d.turnId);
  const missed = (hooks.missedBids || []).map((b) => b.turnId);
  const followUpCount = typeof signals.followUps === 'number' ? signals.followUps : followUps.size;
  const talk = typeof signals.userTalkShare === 'number' ? Math.round(signals.userTalkShare * 100) : null;

  // Face cues: how often they visibly warmed up right after one of your lines.
  let react = { after: 'No camera on this call', other: 'No camera on this call' };
  if (behavior && Array.isArray(behavior.turns)) {
    const warm = (t) => !!t.reaction && ((t.reaction.smileDelta ?? 0) >= 0.05 || (t.reaction.nods ?? 0) >= 1);
    const yours = behavior.turns.filter((t) => t.reaction);
    const after = yours.filter((t) => followUps.has(t.turnId));
    const other = yours.filter((t) => !followUps.has(t.turnId));
    react = {
      after: after.length ? `Smiled or nodded after ${after.filter(warm).length} of ${after.length} follow-ups` : 'No follow-ups to compare',
      other: other.length ? `${other.filter(warm).length} of ${other.length} other lines` : 'No other lines to compare',
    };
  }

  // The three takeaways. Older conversations only have the one-line note, so it stands in.
  let takeaways = raw.insight && Array.isArray(raw.insight.takeaways) ? raw.insight.takeaways.slice(0, 3) : [];
  if (!takeaways.length && raw.note && raw.note.text) {
    const cited = Array.isArray(raw.note.citedTurnIds) ? raw.note.citedTurnIds[0] : null;
    takeaways = [{ kind: 'keep', turnId: cited ?? null, text: raw.note.text }];
    if (raw.note.suggestion) takeaways.push({ kind: 'next', turnId: null, text: raw.note.suggestion });
  }
  return { followUps, missed, followUpCount, talk, react, takeaways };
}

function loadExtras(c) {
  if (state.extras.has(c.id)) return;
  const id = c.id;
  const get = (path) => getJson(path).catch(() => null);
  Promise.all([get(`/api/conversations/${encodeURIComponent(id)}/heatmap`), get(`/api/conversations/${encodeURIComponent(id)}/compare`)]).then(([heat, compare]) => {
    state.extras.set(id, { heat, compare });
    const index = parseHash();
    if (index >= 0 && state.convos[index] && state.convos[index].id === id) renderPage();
  });
}

const flashTimers = new Map();
// "Play the moment": the Figma scrolls the line into view and lights it up for a beat.
function play(turnId) {
  const line = document.getElementById(`ln-${turnId}`);
  if (!line) return;
  line.scrollIntoView({ behavior: 'smooth', block: 'center' });
  line.classList.add('flash');
  clearTimeout(flashTimers.get(turnId));
  flashTimers.set(turnId, window.setTimeout(() => line.classList.remove('flash'), 1800));
}

// <Heat /> from App.tsx: the heatmap's marked words become <mark data-reason>, runs of the same
// reason merged so a flagged phrase reads as one highlight.
function heatText(text, heatTurn) {
  if (!heatTurn || !Array.isArray(heatTurn.words) || !heatTurn.words.length) return [text];
  const out = [];
  let run = null;
  const flush = () => { if (run) { out.push(run.kind ? el('mark', { tabindex: '0', 'data-reason': run.why || run.kind, text: run.words.join(' ') }) : run.words.join(' ')); run = null; } };
  heatTurn.words.forEach((w) => {
    const kind = w.kind || null;
    const why = kind ? (w.why || '') : '';
    if (run && run.kind === kind && run.why === why) run.words.push(w.w);
    else { flush(); run = { kind, why, words: [w.w] }; }
  });
  flush();
  // Words were split on whitespace, so put a space back between runs.
  return out.flatMap((piece, i) => (i ? [' ', piece] : [piece]));
}

function takeawayArticle(c, t, i, an) {
  const turnText = (id) => { const line = c.transcript.find((l) => l[3] === id); return line ? line : null; };
  const n = `${i + 1} · `;
  const playBtn = (id) => el('button', { class: 'play', disabled: id == null || !turnText(id), onclick: () => play(id) }, el('span', { 'aria-hidden': 'true', text: '▶' }), ' Play the moment');
  if (t.kind === 'try') {
    return el('article', { class: 'takeaway try' },
      el('span', { class: 'label', text: `${n}Try this next time` }),
      t.theySaid && el('p', { class: 'tk-them' }, el('b', { text: c.first }), t.theySaid),
      t.said && el('p', { class: 'tk-you' }, el('b', { text: 'You' }), t.said),
      t.tryInstead && el('p', { class: 'tk-rewrite' }, el('b', { text: 'Try instead' }), t.tryInstead),
      !t.tryInstead && t.text && el('p', { class: 'tk-note', text: t.text }),
      playBtn(t.turnId),
    );
  }
  if (t.kind === 'keep') {
    const line = t.turnId != null ? turnText(t.turnId) : null;
    return el('article', { class: 'takeaway keep' },
      el('span', { class: 'label', text: `${n}Keep doing this` }),
      line && el('p', { class: 'tk-you' }, el('b', { text: line[1] === 'me' ? 'You' : c.first }), line[2]),
      el('p', { class: 'tk-note', text: t.text || '' }),
      playBtn(t.turnId),
    );
  }
  return el('article', { class: 'takeaway ask' },
    el('span', { class: 'label', text: `${n}Ask about it next time` }),
    el('p', { class: 'tk-note big', text: t.text || '' }),
    el('button', { class: 'play', onclick: () => draftFollowUp(c) }, el('span', { 'aria-hidden': 'true', text: '✉' }), ' Use in follow-up'),
  );
}

function transcriptPage(index) {
  const c = state.convos[index];
  const back = el('button', { class: 'back-link', onclick: () => { window.location.hash = ''; } }, icon('back', 15), ' Back to overview');
  if (!c) {
    return el('main', { class: 'workspace' }, back,
      el('div', { class: 'page-intro' }, el('div', {}, el('h1', { text: 'Conversation' }), el('p', { class: 'intro-subtitle', text: state.memory ? 'That conversation isn’t here any more.' : 'Loading…' }))));
  }
  loadExtras(c);
  const extras = state.extras.get(c.id) || {};
  const an = analysis(c);
  const heatByTurn = new Map(((extras.heat && extras.heat.turns) || []).map((t) => [t.turnId, t]));
  const metric = (key) => { const m = extras.compare && Array.isArray(extras.compare.metrics) ? extras.compare.metrics.find((x) => x.key === key) : null; return m && m.before != null ? m.before : null; };
  const prevFollowUps = metric('followUps');
  const prevTalk = metric('userTalkShare');
  const times = c.turns.map((t) => t.startMs || 0);
  const ends = c.turns.map((t) => t.endMs || 0);
  const total = Math.max(ends[ends.length - 1] || 0, times[times.length - 1] || 0) + 1000;
  const pct = (ms) => `${(ms / total) * 100}%`;
  const lineAt = (id) => c.turns.find((t) => t.turnId === id);

  const draftBtn = el('button', { class: 'button', onclick: () => draftFollowUp(c, draftBtn) }, 'Draft follow-up ', icon('arrow', 16));

  const deleteBox = el('section', { class: 'privacy-box', 'aria-label': 'Privacy' });
  const renderDelete = () => fill(deleteBox,
    el('div', {},
      el('h3', { text: 'Your data, your call' }),
      el('p', { text: 'Audio is streamed for transcription and not stored. Deleting this conversation removes its transcript, notes, video and face cues.' })),
    state.confirming
      ? el('div', { class: 'confirm-row' },
        el('button', { class: 'button stop-button', onclick: async (e) => {
          const btn = e.currentTarget; btn.disabled = true; btn.textContent = 'Deleting…';
          try {
            const res = await fetch(`/api/conversations/${encodeURIComponent(c.id)}`, { method: 'DELETE' });
            if (!res.ok && res.status !== 404) throw new Error(String(res.status));
            state.confirming = false;
            state.extras.delete(c.id);
            window.location.hash = '';
            refreshMemory();
          } catch {
            btn.disabled = false; btn.textContent = 'Couldn’t delete. Try again';
          }
        }, text: 'Yes, delete it' }),
        el('button', { class: 'button ghost', onclick: () => { state.confirming = false; renderDelete(); }, text: 'Keep it' }))
      : el('button', { class: 'button ghost', onclick: () => { state.confirming = true; renderDelete(); }, text: 'Delete conversation' }),
  );
  renderDelete();

  return el('main', { class: 'workspace' },
    back,
    el('div', { class: 'page-intro' },
      el('div', {}, el('h1', { text: `Conversation with ${c.first}` }), el('p', { class: 'intro-subtitle', text: 'Replay: three takeaways, the moments behind them, and the full transcript.' })),
      el('div', { class: 'intro-actions' },
        el('button', { class: 'button ghost', onclick: () => openReplay(c.id) }, 'Open replay ', icon('arrow', 16)),
        draftBtn),
    ),

    c.needsLabel && el('section', { class: 'uncoached-hero', 'aria-label': 'Not coached yet' },
      el('span', { class: 'label', text: 'Not coached yet' }),
      el('h2', { text: 'Which voice is yours?' }),
      el('p', { text: `Nothing is scored until you pick: we only coach you, never ${c.first}. Finish it on Replay, or tap one of your lines on the phone.` }),
      el('button', { class: 'button', onclick: () => openReplay(c.id) }, 'Finish on Replay ', icon('arrow', 16))),

    an.takeaways.length > 0 && el('section', { class: 'takeaways', 'aria-label': 'Three takeaways' },
      ...an.takeaways.map((t, i) => takeawayArticle(c, t, i, an))),

    // Counts and the timeline would call every line "them" until a voice is picked.
    !c.needsLabel && el('section', { class: 'score-strip', 'aria-label': 'Score strip' },
      el('div', {}, el('b', { text: String(an.followUpCount) }), el('span', { text: 'Follow-ups' }), el('small', { text: prevFollowUps != null ? `Last time: ${prevFollowUps}` : 'First conversation on record' })),
      el('div', {}, el('b', { text: String(an.missed.length) }), el('span', { text: 'Missed moments' }), el('small', { text: 'Openings you moved past' })),
      el('div', {}, el('b', { text: an.talk != null ? `${an.talk}%` : '–' }), el('span', { text: 'You talked' }), el('small', { text: prevTalk != null ? `Last time: ${Math.round(prevTalk * 100)}%` : 'Half is the balance to aim for' })),
      el('div', { class: 'react' }, el('span', { text: 'Reactions' }),
        el('small', {}, el('strong', { text: 'After your follow-ups: ' }), an.react.after),
        el('small', {}, el('strong', { text: 'After other lines: ' }), an.react.other)),
    ),
    !c.needsLabel && el('p', { class: 'cue-note', text: 'Face cues are observable only: smiling, facing and head movement. They never claim to know feelings.' }),

    c.turns.length > 0 && !c.needsLabel && el('section', { class: 'timeline', 'aria-label': 'Timeline' },
      el('div', { class: 'tl-head' },
        el('span', { class: 'label', text: 'Timeline' }),
        el('span', { class: 'tl-key' }, el('i', { class: 'you' }), 'You', el('i', { class: 'them' }), c.first, el('i', { class: 'fu' }), 'Follow-up', el('i', { class: 'ms' }), 'Missed moment')),
      el('div', { class: 'tl-track' },
        ...c.turns.map((t, i) => {
          const start = times[i];
          const end = Math.max(ends[i], i + 1 < times.length ? times[i + 1] : start + 1000);
          const seg = el('i', { class: `seg ${t.speaker === c.userLabel ? 'me' : 'them'}` });
          seg.style.left = pct(start); seg.style.width = pct(Math.max(0, end - start));
          return seg;
        }),
        ...[...an.followUps].filter(lineAt).map((id) => { const b = el('button', { class: 'mark fu', 'aria-label': `Follow-up at ${fmtClock(lineAt(id).startMs || 0)}`, onclick: () => play(id) }); b.style.left = pct(lineAt(id).startMs || 0); return b; }),
        ...an.missed.filter(lineAt).map((id) => { const b = el('button', { class: 'mark ms', 'aria-label': `Missed moment at ${fmtClock(lineAt(id).startMs || 0)}`, onclick: () => play(id) }); b.style.left = pct(lineAt(id).startMs || 0); return b; }),
      ),
      el('div', { class: 'tl-axis' }, el('span', { text: '0:00' }), el('span', { text: fmtClock(total) })),
    ),

    el('div', { class: 'transcripts' },
      el('article', { class: 'transcript', id: `conv-${index}` },
        el('div', { class: 'person-row' },
          el('span', { class: 'person-avatar', text: c.initials }),
          el('div', {}, el('h3', { text: c.name }), el('span', { text: `${c.when} · ${c.duration}` })),
        ),
        el('p', { class: 'heat-note', text: heatByTurn.size ? 'Highlighted words are the few that mattered. Hover or focus one to see why.' : 'The words that mattered light up here once coaching has run.' }),
        el('div', { class: 'transcript-lines' }, ...c.transcript.map(([time, who, text, turnId, speaker]) => {
          const isFu = an.followUps.has(turnId);
          const isMs = an.missed.includes(turnId);
          // Until a voice is picked every line would read as theirs, so keep the diarizer's letters.
          const whoText = c.needsLabel ? (speaker && speaker !== 'unknown' ? `Speaker ${speaker}` : 'Unclear') : who === 'me' ? 'You' : c.first;
          return el('div', { class: `line ${who}${isFu ? ' is-fu' : ''}${isMs ? ' is-ms' : ''}`, id: `ln-${turnId}` },
            el('span', { class: 'line-time', text: time }),
            el('span', { class: 'line-who', text: whoText }),
            el('p', {}, ...heatText(text, heatByTurn.get(turnId)),
              isFu && el('em', { class: 'tag fu', text: 'Follow-up' }),
              isMs && el('em', { class: 'tag ms', text: 'Missed moment' })),
          );
        })),
        reflectionCopy(c, 'transcript-reflection'),
      ),
      deleteBox,
    ),
  );
}

// ---------- follow-up modal ----------

function closeFollowUp() {
  state.modal = null;
  refs.modal?.remove();
  refs.modal = null;
}

// Opens the draft, writing one first if the agent hasn't yet.
async function draftFollowUp(c, btn) {
  if (c.followUp && c.followUp.text) { openFollowUp(c); return; }
  const label = btn ? btn.textContent : null;
  if (btn) { btn.disabled = true; btn.textContent = 'Drafting…'; }
  try {
    const res = await fetch(`/api/conversations/${encodeURIComponent(c.id)}/follow-up`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (!res.ok) throw new Error(String(res.status));
    c.followUp = await res.json();
    if (btn) { btn.disabled = false; btn.textContent = label; }
    openFollowUp(c);
  } catch {
    if (btn) { btn.disabled = false; btn.textContent = 'No draft yet. Get coaching first'; }
  }
}

function openFollowUp(c) {
  closeFollowUp();
  state.modal = c;
  const textarea = el('textarea', { class: 'followup-text', rows: '9' });
  textarea.value = c.followUp.text;
  const copyBtn = el('button', { class: 'button', text: 'Copy message', onclick: async () => {
    // Over plain http (a LAN address) there is no navigator.clipboard; say so rather than claim "Copied".
    let ok = false;
    try { await navigator.clipboard.writeText(textarea.value); ok = true; } catch {
      try { textarea.focus(); textarea.select(); ok = document.execCommand('copy'); } catch { /* nothing to do */ }
    }
    copyBtn.textContent = ok ? 'Copied' : 'Couldn’t copy. Select it and copy by hand';
  } });
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
      if (msg.focus && msg.focus.view === 'recording' && msg.focus.conversationId) {
        // Joined mid-recording (reload, reconnect): our clock is behind the phone's.
        const fresh = !(state.rec.active && state.rec.id === msg.focus.conversationId);
        startRec(msg.focus.conversationId, msg.focus.otherName);
        if (fresh) state.rec.syncPending = true;
      } else stopRec();
      // First connect or a reconnect: anything that changed while we were away.
      refreshMemory();
      break;
    case 'focus':
      if (msg.view === 'recording' && id) startRec(id, msg.otherName);
      else stopRec();
      break;
    case 'partial':
    case 'turn': {
      if (!id) break;
      // A line flushed after `done` belongs to a session that's over.
      if (!state.rec.active && id === state.doneId) break;
      startRec(id, state.rec.id === id ? state.rec.name : null);
      const lines = state.rec.lines;
      if (msg.type === 'partial') {
        const prev = lines.get(msg.turnId);
        if (prev && !prev.partial) break;
        lines.set(msg.turnId, { speaker: msg.speaker || (prev && prev.speaker) || null, text: msg.text || '', partial: true, at: prev ? prev.at : Date.now() });
      } else if (msg.turn) {
        const prev = lines.get(msg.turn.turnId);
        lines.set(msg.turn.turnId, { speaker: msg.turn.speaker, text: msg.turn.text, partial: false, at: prev ? prev.at : Date.now() });
        syncStart(msg.turn);
      }
      renderLive();
      break;
    }
    case 'done':
      if (!id) break;
      state.doneId = id;
      if (state.rec.id === id) stopRec();
      break;
    case 'conversation':
      if (msg.conversation && state.rec.active && msg.conversation.id === state.rec.id && msg.conversation.otherName) startRec(state.rec.id, msg.conversation.otherName);
      // Coaching, video or a label changed: the heat words and the comparison may have too.
      if (msg.conversation && msg.conversation.id) state.extras.delete(msg.conversation.id);
      refreshMemory();
      break;
    case 'deleted':
      if (id && state.rec.id === id) stopRec();
      if (id) state.extras.delete(id);
      refreshMemory();
      break;
    case 'memory':
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

  window.addEventListener('hashchange', () => { closeFollowUp(); state.confirming = false; renderPage(); window.scrollTo(0, 0); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.modal) closeFollowUp(); });
  setInterval(tick, 500);
  loadMe();
  refreshMemory();
  connect();
}

// Whose Mac this is; the hero and the avatar were drawn with the fallback until now.
async function loadMe() {
  try {
    const me = await (await fetch('/api/me')).json();
    if (!me || typeof me.name !== 'string' || !me.name.trim()) return;
    USER.name = me.name.trim();
    USER.initials = initialsOf(USER.name) || USER.initials;
    if (refs.heroH1) refs.heroH1.textContent = `${greeting()}, ${USER.name}`;
    const avatar = document.querySelector('.avatar');
    if (avatar) avatar.textContent = USER.initials;
  } catch { /* the fallback name stays */ }
}

init();

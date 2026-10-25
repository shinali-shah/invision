// Home on the Mac: what to try next time, the planner, the phone's live transcript, and every
// conversation so far. Everything comes from /api/memory and /ws/stage. User text goes in via textContent only.

const $ = (id) => document.getElementById(id);
const SVG = 'http://www.w3.org/2000/svg';

const state = {
  memory: null,
  month: null,          // { year, month } on show in the calendar
  drew: false,          // the hero strand draws in once per page load, never again
  drafts: new Map(),    // id -> edited follow-up text, so closing the modal doesn't lose it
  socketUp: false,
  live: null,           // { id, startedAt, convo, lines: Map(turnId -> { speaker, text, partial }) }
};

// What to work on next, by awkward kind. Only the ones that are about you.
const GOALS = {
  'cut-in': 'Let them finish before you talk',
  gossip: 'Leave stories about other people out',
  undersell: 'Say one real thing about what you do',
  'short-reply': 'Answer, then ask one back',
  hedge: 'Say what you think once, without hedging',
  fizzle: 'End with a reason to talk again',
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

function svg(tag, attrs = {}) {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

async function getJson(url, opts) {
  const res = await fetch(url, opts);
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new Error((body && body.error) || `Request failed (${res.status})`);
  return body;
}

const postJson = (url, data) => getJson(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });

const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { if (value == null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* private mode */ } },
};

// Names come in however they were typed on the phone: "shinali", "Dr. okafor".
function displayName(c) {
  const n = c && typeof c.otherName === 'string' ? c.otherName.trim() : '';
  if (!n || n === 'them') return 'them';
  return n.charAt(0).toUpperCase() + n.slice(1);
}

const dayKey = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }

function relDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const days = Math.round((startOfDay(new Date()) - startOfDay(d)) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  const opts = { month: 'short', day: 'numeric' };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString(undefined, opts);
}

function clock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const quoted = (s) => `“${String(s).trim().replace(/\.\.\./g, '…')}”`;

// The insight builder joins its evidence with middle dots; read it as a sentence instead.
function evidenceLine(s) {
  const parts = String(s || '').split(/\s*·\s*/).map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return '';
  return parts.map((p, i) => (i ? p.charAt(0).toLowerCase() + p.slice(1) : p)).join(', ');
}

const takeaway = (c, kind) => ((c.insight && c.insight.takeaways) || []).find((t) => t && t.kind === kind) || null;
const yourFlags = (c) => (((c.hooks && c.hooks.awkward) || {}).flags || []).filter((f) => f && f.who === 'you');
const hasTurns = (c) => Array.isArray(c.turns) && c.turns.some((t) => Number.isFinite(t.startMs) && Number.isFinite(t.endMs));
const newestFirst = (list) => [...list].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

function howItWent(score) {
  if (!Number.isFinite(score)) return null;
  if (score < 30) return 'well';
  if (score < 70) return 'some';
  return 'rough';
}
const WENT = { well: 'went well', some: 'some awkward moments', rough: 'awkward' };

// ---------- the strand ----------

// Two lanes, you over them, bar length is how long each spoke. Brick for your awkward moments,
// amber for moments you missed, a teal dot over each follow-up question.
function strand(c, { width, size }) {
  const big = size === 'big';
  const g = big
    ? { h: 84, dotY: 7, dotR: 4, youY: 18, laneH: 22, gap: 6, tick: 3 }
    : { h: 30, dotY: 3, dotR: 2.2, youY: 7, laneH: 8, gap: 2, tick: 2 };
  const themY = g.youY + g.laneH + g.gap;
  const turns = (c.turns || []).filter((t) => Number.isFinite(t.startMs) && Number.isFinite(t.endMs) && t.endMs > t.startMs);
  const t0 = Math.min(...turns.map((t) => t.startMs));
  const t1 = Math.max(...turns.map((t) => t.endMs));
  const span = Math.max(1, t1 - t0);
  const x = (ms) => ((ms - t0) / span) * width;
  const you = c.userLabel || (turns[0] && turns[0].speaker);
  const byId = new Map(turns.map((t) => [t.turnId, t]));

  const root = svg('svg', { class: `hm-strand is-${size}`, width, height: g.h, viewBox: `0 0 ${width} ${g.h}`, role: 'img' });

  root.append(svg('line', { class: 'hm-strand-axis', x1: 0, x2: width, y1: themY - g.gap / 2, y2: themY - g.gap / 2 }));
  for (const t of turns) {
    if (!t.speaker || t.speaker === 'unknown') continue;
    const mine = t.speaker === you;
    const x0 = x(t.startMs);
    const w = Math.max(big ? 2 : 1.5, x(t.endMs) - x0 - (big ? 1.5 : 0.75));
    root.append(svg('rect', { class: mine ? 'hm-bar-you' : 'hm-bar-them', x: x0.toFixed(1), y: mine ? g.youY : themY, width: w.toFixed(1), height: g.laneH, rx: big ? 3 : 1.5 }));
  }

  const flagged = new Set();
  for (const f of yourFlags(c)) {
    const t = byId.get(f.turnId);
    if (!t || flagged.has(t.turnId)) continue;
    flagged.add(t.turnId);
    root.append(svg('rect', { class: 'hm-mark-awk', x: (x(t.startMs) - g.tick / 2).toFixed(1), y: g.youY - (big ? 6 : 3), width: g.tick, height: g.laneH + (big ? 10 : 5), rx: 1 }));
  }
  const bids = (c.hooks && c.hooks.missedBids) || [];
  for (const b of bids) {
    const t = byId.get(b.replyTurnId) || byId.get(b.turnId);
    if (!t) continue;
    root.append(svg('rect', { class: 'hm-mark-missed', x: (x(t.startMs) - g.tick / 2).toFixed(1), y: themY - (big ? 4 : 2), width: g.tick, height: g.laneH + (big ? 10 : 5), rx: 1 }));
  }
  const follows = ((c.signals && c.signals.questions) || []).filter((q) => q && q.isFollowUp);
  for (const q of follows) {
    const t = byId.get(q.turnId);
    if (!t) continue;
    root.append(svg('circle', { class: 'hm-mark-follow', cx: x((t.startMs + t.endMs) / 2).toFixed(1), cy: g.dotY, r: g.dotR }));
  }

  const n = flagged.size;
  const bits = [`${clock(span)} of talking, you on top and ${displayName(c)} below`];
  if (n) bits.push(`${n} awkward ${n === 1 ? 'moment' : 'moments'}`);
  if (bids.length) bits.push(`${bids.length} missed ${bids.length === 1 ? 'moment' : 'moments'}`);
  if (follows.length) bits.push(`${follows.length} follow-up ${follows.length === 1 ? 'question' : 'questions'}`);
  root.setAttribute('aria-label', bits.join(', '));
  return root;
}

// ---------- hero ----------

function openReplay(id) {
  if (window.parent !== window) window.parent.postMessage({ type: 'playback:open-replay', id }, location.origin);
  else location.href = `replay.html?id=${encodeURIComponent(id)}`;
}

let heroConvo = null;

function renderHero(convos) {
  const hero = $('hero');
  const sorted = newestFirst(convos);
  const withTry = sorted.find((c) => takeaway(c, 'try') && takeaway(c, 'try').tryInstead && hasTurns(c));
  const withNote = sorted.find((c) => c.note && (c.note.suggestion || c.note.text));
  heroConvo = withTry || withNote || null;

  if (!heroConvo) {
    hero.replaceChildren(
      el('h1', { class: 'hm-hero-lead', id: 'hero-lead', text: 'Record your first conversation on your phone' }),
      el('p', { class: 'hm-hero-empty', text: 'Afterwards you’ll see here what to try next time, drawn from what they actually said.' }),
    );
    return;
  }

  const c = heroConvo;
  const kids = [];
  if (withTry) {
    const t = takeaway(c, 'try');
    kids.push(el('h1', { class: 'hm-hero-lead', id: 'hero-lead', text: `Next time with ${displayName(c)}, try` }));
    kids.push(el('blockquote', { class: 'hm-hero-try', text: quoted(t.tryInstead) }));
    kids.push(el('div', { class: 'hm-hero-strand', id: 'hero-strand' }));
    const ev = evidenceLine(t.evidence) || t.title || '';
    kids.push(el('div', { class: 'hm-hero-foot' },
      el('p', { class: 'hm-hero-ev' },
        ev ? el('span', { text: `${ev}.` }) : null,
        t.theySaid ? el('span', { class: 'hm-hero-ctx' }, `${displayName(c)} had just said `, el('q', { class: 'hm-speech', text: t.theySaid.trim() }), '.') : null),
      replayButton(c)));
  } else {
    kids.push(el('h1', { class: 'hm-hero-lead', id: 'hero-lead', text: `Next time with ${displayName(c)}` }));
    kids.push(el('p', { class: 'hm-hero-advice', text: c.note.suggestion || c.note.text }));
    if (hasTurns(c)) kids.push(el('div', { class: 'hm-hero-strand', id: 'hero-strand' }));
    kids.push(el('div', { class: 'hm-hero-foot' },
      el('p', { class: 'hm-hero-ev', text: `From your conversation ${relDate(c.createdAt).toLowerCase()}.` }),
      replayButton(c)));
  }
  hero.replaceChildren(...kids);
  drawHeroStrand();
}

function replayButton(c) {
  const b = el('button', { type: 'button', class: 'hm-btn is-primary', text: 'Open replay' });
  b.addEventListener('click', () => openReplay(c.id));
  return b;
}

function drawHeroStrand() {
  const box = $('hero-strand');
  if (!box || !heroConvo) return;
  const width = Math.max(200, Math.floor(box.clientWidth - 72));
  const s = strand(heroConvo, { width, size: 'big' });
  const turns = heroConvo.turns.filter((t) => Number.isFinite(t.startMs));
  const total = Math.max(...turns.map((t) => t.endMs)) - Math.min(...turns.map((t) => t.startMs));
  if (!state.drew) { s.classList.add('draws'); state.drew = true; }
  box.replaceChildren(
    el('span', { class: 'hm-lane-name is-you', text: 'You', 'aria-hidden': 'true' }),
    el('span', { class: 'hm-lane-name is-them', text: displayName(heroConvo), 'aria-hidden': 'true' }),
    el('div', { class: 'hm-strand-wrap' }, s),
    el('span', { class: 'hm-strand-t is-start', text: '0:00', 'aria-hidden': 'true' }),
    el('span', { class: 'hm-strand-t is-end', text: clock(total), 'aria-hidden': 'true' }),
  );
}

let resizeTimer = null;
new ResizeObserver(() => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(drawHeroStrand, 120);
}).observe($('hero'));

// ---------- calendar ----------

function dayMap(convos) {
  const days = new Map();
  for (const c of convos) {
    if (!hasTurns(c)) continue;
    const d = new Date(c.createdAt);
    if (Number.isNaN(d.getTime())) continue;
    const key = dayKey(d);
    const score = c.hooks && c.hooks.awkward ? c.hooks.awkward.score : null;
    const prev = days.get(key) || { count: 0, worst: null };
    prev.count += 1;
    // A day is as good as its roughest conversation.
    if (Number.isFinite(score)) prev.worst = prev.worst == null ? score : Math.max(prev.worst, score);
    days.set(key, prev);
  }
  return days;
}

function streak(days) {
  const d = startOfDay(new Date());
  // Nothing yet today doesn't break it; today just hasn't happened.
  if (!days.has(dayKey(d))) d.setDate(d.getDate() - 1);
  let n = 0;
  while (days.has(dayKey(d))) { n += 1; d.setDate(d.getDate() - 1); }
  return n;
}

function renderCalendar(convos) {
  const now = new Date();
  if (!state.month) state.month = { year: now.getFullYear(), month: now.getMonth() };
  const { year, month } = state.month;
  const days = dayMap(convos);
  const first = new Date(year, month, 1);
  const total = new Date(year, month + 1, 0).getDate();
  const offset = (first.getDay() + 6) % 7; // weeks start on Monday
  const atNow = year === now.getFullYear() && month === now.getMonth();

  $('cal-month').textContent = first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  $('cal-next').disabled = atNow;

  const grid = $('cal-grid');
  const cells = [];
  for (const w of ['M', 'T', 'W', 'T', 'F', 'S', 'S']) cells.push(el('span', { class: 'hm-cal-wd', text: w, 'aria-hidden': 'true' }));
  for (let i = 0; i < offset; i += 1) cells.push(el('span', { class: 'hm-cal-pad', 'aria-hidden': 'true' }));
  for (let day = 1; day <= total; day += 1) {
    const date = new Date(year, month, day);
    const info = days.get(dayKey(date));
    const went = info ? howItWent(info.worst) || 'well' : null;
    const isToday = atNow && day === now.getDate();
    const label = date.toLocaleDateString(undefined, { month: 'long', day: 'numeric' });
    const said = info ? `, ${info.count} ${info.count === 1 ? 'conversation' : 'conversations'}, ${WENT[went]}` : '';
    cells.push(el('span', {
      class: `hm-cal-day${went ? ` is-${went}` : ''}${isToday ? ' is-today' : ''}${date > now ? ' is-future' : ''}`,
      text: String(day),
      role: 'img',
      'aria-label': `${label}${isToday ? ', today' : ''}${said}`,
    }));
  }
  grid.replaceChildren(...cells);

  const n = streak(days);
  $('streak').replaceChildren(...(n
    ? [el('strong', { text: `${n}-day streak` }), el('span', { text: `Talk to someone ${days.has(dayKey(now)) ? 'tomorrow' : 'today'} to keep it` })]
    : [el('span', { text: 'Talk to someone today to start a streak' })]));
}

$('cal-prev').addEventListener('click', () => {
  const d = new Date(state.month.year, state.month.month - 1, 1);
  state.month = { year: d.getFullYear(), month: d.getMonth() };
  if (state.memory) renderCalendar(state.memory.conversations || []);
});
$('cal-next').addEventListener('click', () => {
  const d = new Date(state.month.year, state.month.month + 1, 1);
  state.month = { year: d.getFullYear(), month: d.getMonth() };
  if (state.memory) renderCalendar(state.memory.conversations || []);
});

// ---------- goal ----------

function renderGoal(step, convos) {
  const box = $('goal');
  if (!step) {
    box.replaceChildren(el('p', { class: 'hm-quiet', text: 'Your weekly goal appears after your first coached conversation.' }));
  } else {
    const done = step.status === 'dismissed';
    const err = el('p', { class: 'hm-err', role: 'alert', hidden: true });
    const act = async (action, buttons) => {
      err.hidden = true;
      buttons.forEach((b) => { b.disabled = true; });
      try {
        const updated = await postJson(`/api/next-step/${encodeURIComponent(step.id)}`, { action });
        if (state.memory) state.memory.nextStep = updated;
        renderGoal(updated, convos);
      } catch (e) {
        buttons.forEach((b) => { b.disabled = false; });
        err.textContent = e.message;
        err.hidden = false;
      }
    };
    const actions = el('div', { class: 'hm-goal-actions' });
    if (!done) {
      const accept = el('button', { type: 'button', class: 'hm-btn is-primary', text: 'Accept' });
      const finish = el('button', { type: 'button', class: 'hm-btn', text: 'Done' });
      const both = [accept, finish];
      accept.addEventListener('click', () => act('accept', both));
      finish.addEventListener('click', () => act('dismiss', both));
      if (step.status === 'proposed') actions.append(accept, finish);
      else actions.append(finish);
    }
    const status = done ? 'Done for this week.' : step.status === 'accepted' ? 'You’re on it this week.' : step.status === 'changed' ? 'Your own version.' : null;
    box.replaceChildren(
      el('p', { class: `hm-goal-text${done ? ' is-done' : ''}`, text: step.text }),
      ...(status ? [el('p', { class: 'hm-quiet', text: status })] : []),
      ...(actions.childElementCount ? [actions] : []),
      err,
    );
  }

  // Small, concrete things from the latest conversation's rough spots.
  const latest = newestFirst(convos).find((c) => c.hooks && c.hooks.awkward);
  const list = $('goal-checks');
  const kinds = [];
  if (latest) {
    for (const f of [...yourFlags(latest)].sort((a, b) => b.weight - a.weight)) {
      if (GOALS[f.kind] && !kinds.includes(f.kind)) kinds.push(f.kind);
      if (kinds.length === 2) break;
    }
  }
  list.replaceChildren(...kinds.map((kind) => {
    const key = `playback-goal:${latest.id}:${kind}`;
    const id = `goal-${kind}`;
    const box = el('input', { type: 'checkbox', id });
    box.checked = store.get(key) === '1';
    box.addEventListener('change', () => store.set(key, box.checked ? '1' : null));
    return el('li', { class: 'hm-check' }, box, el('label', { for: id, text: GOALS[kind] }));
  }));
}

// ---------- follow-ups ----------

function renderFollowUps(convos) {
  const list = $('followups');
  const rows = [];
  for (const c of newestFirst(convos)) {
    if (c.followUp && c.followUp.status === 'draft' && c.followUp.text) {
      const open = el('button', { type: 'button', class: 'hm-btn is-small', text: 'Write', 'aria-label': `Write the follow-up to ${displayName(c)}` });
      open.addEventListener('click', () => openFollowUp(c, open));
      rows.push(el('li', { class: 'hm-todo-row' },
        el('span', { class: 'hm-todo-what' }, el('strong', { text: displayName(c) }), el('span', { class: 'hm-quiet', text: 'Draft ready' })),
        open));
    }
  }
  // Promises they made out loud. Ticking one off stays on this Mac.
  for (const c of newestFirst(convos).slice(0, 8)) {
    for (const p of (c.hooks && c.hooks.commitments) || []) {
      if (!p || !p.text) continue;
      const key = `playback-promise:${c.id}:${p.turnId}`;
      const id = `promise-${c.id}-${p.turnId}`;
      const box = el('input', { type: 'checkbox', id });
      box.checked = store.get(key) === '1';
      box.addEventListener('change', () => store.set(key, box.checked ? '1' : null));
      rows.push(el('li', { class: 'hm-check is-promise' }, box,
        el('label', { for: id },
          el('span', { class: 'hm-promise-to', text: `You said to ${displayName(c)}` }),
          el('span', { class: 'hm-speech', text: quoted(p.text) }))));
    }
  }
  if (!rows.length) rows.push(el('li', { class: 'hm-quiet', text: 'Nothing to send. Drafts show up here after each conversation.' }));
  list.replaceChildren(...rows);
}

let modalConvo = null;
let modalOpener = null;

function openFollowUp(c, opener) {
  modalConvo = c;
  modalOpener = opener;
  $('fu-modal-title').textContent = `Follow-up for ${displayName(c)}`;
  $('fu-modal-note').textContent = `Drafted from your conversation ${relDate(c.createdAt).toLowerCase()}. Change anything before you send it.`;
  $('fu-text').value = state.drafts.get(c.id) ?? c.followUp.text;
  $('fu-copy').textContent = 'Copy message';
  $('fu-err').hidden = true;
  $('fu-sent').disabled = false;
  $('fu-modal').showModal();
  $('fu-text').focus();
}

$('fu-text').addEventListener('input', () => {
  if (modalConvo) state.drafts.set(modalConvo.id, $('fu-text').value);
  $('fu-copy').textContent = 'Copy message';
});

$('fu-copy').addEventListener('click', async () => {
  const text = $('fu-text').value;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Clipboard API can be blocked in a frame; selecting lets Cmd+C do it.
    $('fu-text').select();
    try { document.execCommand('copy'); } catch { /* left selected */ }
  }
  $('fu-copy').textContent = 'Copied';
});

$('fu-sent').addEventListener('click', async () => {
  if (!modalConvo) return;
  const text = $('fu-text').value.trim();
  if (!text) { $('fu-err').textContent = 'The message is empty. Write something or close.'; $('fu-err').hidden = false; return; }
  $('fu-sent').disabled = true;
  try {
    const followUp = await postJson(`/api/conversations/${encodeURIComponent(modalConvo.id)}/follow-up/sent`, { text });
    state.drafts.delete(modalConvo.id);
    const c = state.memory && (state.memory.conversations || []).find((x) => x.id === modalConvo.id);
    if (c) c.followUp = followUp;
    $('fu-modal').close();
    render();
  } catch (e) {
    $('fu-sent').disabled = false;
    $('fu-err').textContent = e.message;
    $('fu-err').hidden = false;
  }
});

$('fu-modal').addEventListener('close', () => {
  const back = modalOpener;
  modalConvo = null;
  modalOpener = null;
  if (back && back.isConnected) back.focus();
  else $('followups').querySelector('button')?.focus();
});
// A click on the backdrop lands on the dialog itself.
$('fu-modal').addEventListener('click', (e) => { if (e.target === $('fu-modal')) $('fu-modal').close(); });

// ---------- conversations ----------

function worksMark() {
  const m = svg('svg', { class: 'hm-worked-mark', viewBox: '0 0 16 16', 'aria-hidden': 'true' });
  m.append(svg('path', { d: 'M3.5 8.5l3 3 6-7' }));
  return m;
}

function renderConvos(convos) {
  const list = $('convos');
  const rows = newestFirst(convos).filter(hasTurns).map((c) => {
    const keep = takeaway(c, 'keep');
    const tryT = takeaway(c, 'try');
    const happened = (c.note && c.note.text) || '';
    const next = tryT && tryT.tryInstead
      ? el('span', { class: 'hm-speech', text: quoted(tryT.tryInstead) })
      : el('span', { text: (c.note && c.note.suggestion) || '' });
    const awk = yourFlags(c).length;
    const btn = el('button', { type: 'button', class: 'hm-convo' },
      el('span', { class: 'hm-convo-who' },
        el('span', { class: 'hm-convo-name', text: displayName(c) }),
        el('span', { class: 'hm-convo-date', text: relDate(c.createdAt) })),
      el('span', { class: 'hm-convo-strand' }, strand(c, { width: 148, size: 'mini' })),
      el('span', { class: 'hm-convo-col' },
        el('span', { class: 'hm-sr', text: 'What happened: ' }),
        el('span', { class: 'hm-clamp', text: happened }),
        keep && keep.text ? el('span', { class: 'hm-worked' }, worksMark(), el('span', {}, el('strong', { text: 'Worked: ' }), keep.text)) : null),
      el('span', { class: 'hm-convo-col' }, el('span', { class: 'hm-sr', text: 'Next time: ' }), el('span', { class: 'hm-clamp' }, next)),
      el('span', { class: 'hm-convo-awk', text: awk > 0 ? `${awk} awkward` : '' }),
      el('span', { class: 'hm-sr', text: '. Open replay' }));
    btn.addEventListener('click', () => openReplay(c.id));
    return el('li', {}, btn);
  });
  if (!rows.length) rows.push(el('li', { class: 'hm-quiet hm-convo-empty', text: 'No conversations yet. They’ll be listed here once you record one on your phone.' }));
  list.replaceChildren(...rows);
}

// ---------- recording, mirrored from the phone ----------

function speakerName(speaker, c) {
  if (!speaker || speaker === 'unknown') return { who: 'Unclear', lane: null };
  if (!c || !c.userLabel) return { who: `Speaker ${speaker}`, lane: null };
  if (speaker === c.userLabel) return { who: 'You', lane: 'you' };
  return { who: displayName(c) === 'them' ? `Speaker ${speaker}` : displayName(c), lane: 'them' };
}

function renderRec() {
  const live = state.live;
  const rec = $('rec');
  rec.classList.toggle('is-live', !!live);
  $('rec-clock').hidden = !live;
  $('rec-lines').hidden = !live;
  $('rec-how').hidden = !!live;
  if (!live) {
    $('rec-title').textContent = 'Start a conversation on your phone';
    return;
  }
  const name = live.convo ? displayName(live.convo) : live.otherName;
  $('rec-title').textContent = name && name !== 'them' ? `Recording with ${name} on your phone` : 'Recording on your phone';
  updateClock();
  const lines = [...live.lines.values()].filter((l) => l.text && l.text.trim()).slice(-6);
  const items = lines.map((l) => {
    const { who, lane } = speakerName(l.speaker, live.convo);
    return el('li', { class: `hm-line${lane ? ` is-${lane}` : ''}${l.partial ? ' is-partial' : ''}` },
      el('span', { class: 'hm-line-who', text: who }),
      el('p', { class: 'hm-speech', text: l.text }));
  });
  if (!items.length) items.push(el('li', { class: 'hm-quiet', text: 'Listening. Lines appear as each of you speaks.' }));
  $('rec-lines').replaceChildren(...items);
}

function updateClock() {
  if (state.live) $('rec-clock').textContent = clock(Date.now() - state.live.startedAt);
}
setInterval(updateClock, 500);

function startLive(id, otherName) {
  if (state.live && state.live.id === id) return;
  state.live = { id, startedAt: Date.now(), convo: null, otherName: otherName || null, lines: new Map() };
  getJson(`/api/conversations/${encodeURIComponent(id)}`).then((c) => {
    if (state.live && state.live.id === id) { state.live.convo = c; renderRec(); }
  }).catch(() => { /* the lines still show, just without names */ });
}

function stopLive() {
  if (!state.live) return;
  state.live = null;
  renderRec();
}

// ---------- data and socket ----------

let refreshTimer = null;
function refreshSoon() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, 300);
}

async function refresh() {
  try {
    state.memory = await getJson('/api/memory');
    render();
  } catch (e) {
    if (!state.memory) {
      $('hero').replaceChildren(
        el('h1', { class: 'hm-hero-lead', id: 'hero-lead', text: 'Can’t reach Playback on this Mac' }),
        el('p', { class: 'hm-hero-empty', text: `${e.message}. Check the server is running; this page retries when it reconnects.` }),
      );
    }
  }
}

function render() {
  const convos = (state.memory && state.memory.conversations) || [];
  renderHero(convos);
  renderCalendar(convos);
  renderGoal(state.memory && state.memory.nextStep, convos);
  renderFollowUps(convos);
  renderConvos(convos);
  renderRec();
}

function handle(msg) {
  const id = msg.conversationId;
  switch (msg.type) {
    case 'hello':
      if (msg.focus && msg.focus.view === 'recording' && msg.focus.conversationId) startLive(msg.focus.conversationId, msg.focus.otherName);
      renderRec();
      break;
    case 'focus':
      if (msg.view === 'recording' && id) startLive(id, msg.otherName);
      else stopLive();
      renderRec();
      break;
    case 'partial':
    case 'turn': {
      if (!id) break;
      if (!state.live || state.live.id !== id) startLive(id);
      const lines = state.live.lines;
      if (msg.type === 'partial') {
        const prev = lines.get(msg.turnId);
        if (prev && !prev.partial) break;
        lines.set(msg.turnId, { speaker: msg.speaker || (prev && prev.speaker) || 'unknown', text: msg.text || '', partial: true });
      } else if (msg.turn) {
        lines.set(msg.turn.turnId, { speaker: msg.turn.speaker, text: msg.turn.text, partial: false });
      }
      renderRec();
      break;
    }
    case 'done':
      if (state.live && state.live.id === id) stopLive();
      refreshSoon();
      break;
    case 'conversation':
      if (state.live && msg.conversation && msg.conversation.id === state.live.id) { state.live.convo = msg.conversation; renderRec(); }
      refreshSoon();
      break;
    case 'memory':
    case 'deleted':
      refreshSoon();
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
    setTimeout(connect, 2000);
    return;
  }
  ws.onopen = () => {
    // Anything that happened while we were away.
    if (attempt > 0) refresh();
    attempt = 0;
  };
  ws.onmessage = (e) => {
    if (typeof e.data !== 'string') return;
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    try { handle(msg); } catch (err) { console.error('home: stage message failed', msg.type, err); }
  };
  ws.onclose = () => {
    attempt += 1;
    setTimeout(connect, Math.min(10000, 500 * 2 ** attempt));
  };
}

const theme = new URLSearchParams(location.search).get('theme');
if (theme === 'dark' || theme === 'light') document.documentElement.dataset.theme = theme;

refresh();
connect();

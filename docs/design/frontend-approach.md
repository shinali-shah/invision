# Playback front end: the full approach

A self-contained description of how the Playback front end is built, for anyone (or any model) extending it.

## 1. What the product is

Playback coaches you on how you listen. You wear a mic (and optionally point a phone camera) during a real
conversation. Afterwards you get one specific piece of advice backed by the moment it came from: what they
said, what you said, and the line that would have landed better. It remembers people, so you get a brief
before you talk to someone again and a before/after once you have. There are two clients:

- **The phone** (iPhone Safari over https): records, transcribes live, asks which voice is yours, shows the
  coaching, the comparison with last time, what was picked up, and a drafted follow-up you can send.
- **The Mac** (`/mac`): one page with two tabs. **Home** is the dashboard (a direct port of the team's Figma
  Make design) and shows the live transcript while the phone records. **Replay** plays the video with face
  cues lined up against the transcript and the three takeaways. The projector view (`/stage.html`) is a
  separate page, linked from Home's recording card.

## 2. Stack and constraints

- Server: Node 24 ESM, Express 5, `ws`, `node:sqlite`. It serves `public/` statically; `/mac` serves
  `public/studio.html`.
- Front end: **vanilla JavaScript ES modules, no build step, no framework, no dependencies** except the
  vendored MediaPipe Tasks Vision bundle used by Replay (`public/vendor/mediapipe/`).
- Every page builds DOM with a small `el(tag, props, ...children)` helper and **`textContent` only**. Nothing
  from the API, the transcript or user input ever goes through `innerHTML`.
- Each page is a plain HTML file plus one JS module and one CSS file: `index.html/app.js/styles.css` (phone),
  `stage.html/stage.js/stage.css` (Live), `replay.html/replay.js/replay.css` (Replay),
  `home.html/home.js/home.css` (Home), `studio.html` (the Mac shell, self-contained), `api.js` (fetch
  wrappers used by the phone), `mic.js` and `pcm-worklet.js` (audio capture helpers), `tokens.css` (design
  tokens, loaded by every page).

## 3. Design system

The look is the team's Figma Make design, version 2 (night / paper / marigold). Its tokens, type, shapes and the
components every screen reuses are listed in `playback-ui.md` next to this file; `public/tokens.css` holds the
values and `public/home.*` is a direct port. The rules that don't change between versions:

- Start from a Figma component; don't invent a new card, label or button style.
- Colour meaning is fixed across screens: **you** = the green "you" token, **them** = grey, **awkward** = red,
  **missed moment** = marigold, **went well** = green. Colour never carries meaning alone; each state also has a
  label or icon.
- Motion: the Figma's own animations only (drifting clouds behind the hero, card-in on panels, the REC pulse,
  the caret blink, today-glow and save-pop on the calendar). Everything respects `prefers-reduced-motion`.
- Dark: the Figma is light only. `?theme=dark` is supported through token overrides for projectors that wash
  out light pages.
- Phone sizing: body 16px, tap targets at least 44px (record/stop 56px), safe-area insets, no horizontal
  scroll at 375px.

## 4. The Mac shell (`/mac`, `public/studio.html`)

- A sticky 72px header in the Figma style: logo + "Playback" on the left, the two tabs centred as
  `.status-pill` buttons (selected = ink background, white text), then "Open Replay when a video is ready"
  (checkbox, persisted in localStorage, on by default), a phone-status pill, and the "PS" avatar.
- Home and Replay are two iframes that stay loaded, so switching is instant. Keys `1` / `2` and arrow keys
  switch tabs. The hash mirrors the state (`#home`, `#replay=<conversationId>`); an unknown hash, including
  the old `#live`, lands on Home. The Live tab was dropped because Home's recording card already carries
  the live transcript; `stage.html` stays as the standalone projector page.
- The shell subscribes to `/ws/stage`. The phone-status pill reads "Waiting for your phone", "Phone
  connected", "Recording on your phone" (red pulsing dot) or "Reconnecting to this Mac". When a conversation
  arrives with both a recording and a note, the shell shows "Video ready" and, if the checkbox is on, jumps
  to Replay for that id.
- Child pages detect `window.self !== window.top`, add an `embedded` class and hide their own headers. They
  ask the shell to open Replay with `parent.postMessage({ type: 'playback:open-replay', id }, location.origin)`.

## 5. Home (`public/home.*`): the Figma dashboard with real data

`home.css` is the Figma's `index.css` unchanged (fonts come from `tokens.css`). `home.js` reproduces the
Figma's React tree as DOM with the same class names and order, then binds it to the API.

- Hero: `.hero-intro` with three `.cloud` spans, a mono `.hero-date` ("Sunday · Oct 25, 2026"), the
  "OVERVIEW" label, an `<h1>` greeting by time of day ("Good evening, Parth"), and the subtitle.
- Planner rail (`.planner`, one white panel, cards separated by rules):
  - **Your calendar**: month navigation, a streak pill with the flame icon and "Log today" (localStorage,
    pops the save animation), weekday row, month grid. Each day is coloured by that day's conversations:
    green = went well, yellow = a few bumps, red = rough one, from the maximum `hooks.awkward.score`
    (under 30, under 70, otherwise). Days with nothing stay plain. Today has the glowing ring.
  - **Goals**: a progress bar plus check rows. The first goal is the server's weekly `nextStep.text`; up to
    two more are derived from the latest conversation's awkward flags (cut-in → "Let them finish before you
    talk", gossip → "Leave stories about other people out", undersell → "Say one real thing about what you
    do"); the Figma's three strings fill any gap. Checked state lives in localStorage.
  - **Pending tasks**: one row per conversation whose `followUp.status === 'draft'` ("Follow up with Maya")
    with the "Write me a follow up" button, plus one per promise in `hooks.commitments` ("You said: …").
- Activity column:
  - **Recording card**: follows `/ws/stage`. Idle shows "Ready when you are" and a static consent-step
    ("Start on your phone. Tell them you're recording before you tap Record."). While the phone records it
    becomes `.is-recording`: red left border, REC pulse, "Session with {name}", a disabled
    "Recording on your phone" pill where the Figma's Stop button sits, the live transcript fed by `partial`
    and `turn` messages (caret on the open partial), the mono elapsed timer (ticks only while recording,
    then freezes at the session length), "{name} agreed to be recorded", "Private to you".
  - **Recent conversations**: `.conversation` rows with initials avatar, name, "Today, 12:41 AM" style
    time in mono, "View full →", and the two columns "What worked well" (the `keep` takeaway, else the
    note text) and "What I'll do next time" (the `try` takeaway's `tryInstead`, else the note suggestion).
- Transcript page at `#conversations/<i>`: back link, the person row, the Figma `.line` transcript (time |
  who | text), the reflection block, and an "Open replay" link that messages the shell.
- Follow-up modal: "DRAFT FOR {NAME}" label, textarea with the drafted message, Close, "Copy message" (turns
  into "Copied"), and an added "Mark sent" that posts to the server and removes the task.

## 6. The phone (`public/index.html`, `app.js`, `styles.css`, `api.js`, `mic.js`, `pcm-worklet.js`)

Views are sections toggled with `hidden`; `showView(name)` switches them and reports the focus to the server
so the Mac follows (`POST /api/stage/focus`).

- **Start**: "Who are you talking with?", the tag pills (Family / Friend / Networking) with a one-line focus
  for each, the name input (debounced 400ms → `GET /api/brief?name=` → the "Before you talk to {name}" card
  with Follow through / Ask how it went / Bring up / Try items), the Camera toggle ("Point the phone at them.
  Video stays on your Mac."), the consent step ("I told them I'm recording audio and video"), and the big
  Record button, disabled until consent is ticked.
- **Recording**: created the conversation first (`POST /api/conversations`), then captures audio through an
  `AudioWorklet` → mono fold → automatic level (brings quiet external mics up to about −22 dB) → limiter →
  24 kHz PCM frames over `WS /ws/transcribe`, and records video + the levelled audio with `MediaRecorder`.
  The screen shows the live transcript (partials in fog, finished turns solid), a small camera preview in the
  corner of the sticky bar, the elapsed timer and Stop. iOS rules are respected: the `AudioContext` is
  created and resumed inside the tap before any `await`; `navigator.share` is called synchronously in the
  Send tap; the recorder is stopped before the tracks.
- **Label**: "Which voice is yours? Tap one of your own lines." Picking a line posts `user-label`, reveals
  the reflection box and "Get coaching". Video upload status ("Uploading video… 40%", "Video saved", or
  "Video didn't upload" with Retry) sits here too.
- **Coaching**: the coaching note card (note text, suggestion in teal Newsreader), the Video card with "Open
  Replay on the Mac", "Compared with last time" (before → after per metric with ↑ / ↓ / =, "Last note said…"
  with "You did it" or "Not yet"), "What we picked up" (awkward moments first, then topics, coming up,
  promises, missed moments, the follow-up detector line), the follow-up message (textarea, Send via the share
  sheet or clipboard, Rewrite), Your counts, the transcript with your lines tinted teal and cited lines
  highlighted, "Wrong kind of conversation?" retag pills, See memory, Delete conversation.
- **Memory**: the list of conversations (initials avatars), the pattern with its numbers, and the weekly next
  step with Accept / Change / Dismiss. A Logs drawer shows each agent's log line.
- Race guards: every async render checks `stillOn(view, id)` or a sequence number before touching the DOM,
  so slow responses never repaint a view the user has left.

## 7. Live (`public/stage.*`)

The projector view. Everything is sized off `--u: min(1vw, 1.7778vh)` so 1920×1080 and 1440×900 both fill
the wall. It subscribes to `/ws/stage` and renders whatever the phone is focused on: the start tagline (in
Fraunces) with the pre-meeting brief when a name is typed, the live transcript while recording, the label
step, the coaching note with counts, the comparison, the follow-up as a big quote with a "Sent ✓" pill, hooks
as chips, and the memory view. Retagging on the phone swaps the note on the wall.

## 8. Replay (`public/replay.*`)

- Opens `replay.html?id=<conversationId>` (no id → a list of conversations with a "No video" or
  "Transcript only" pill).
- Hero: the video on the left with a canvas overlay (face landmark dots and live smile / facing / nod
  meters); on the right, **takeaways** from `insight.takeaways`. The first is the big card: the "Try this
  next time" label, a ▶ time chip that seeks and plays, their line, "You said" with your line struck through,
  "Try" with `tryInstead` large in Newsreader teal, the evidence line (e.g. "Gossip about someone else, Cut
  in" or "Smile −8 · looked away 2.5 s") and one sentence of why. Takeaways two and three are compact cards
  (✓ keep, → next, ↺ try).
- Score strip: awkward moments (red when above 0), "2 of 4" questions were follow-ups, missed moments,
  smile after follow-ups vs other lines with small bars, % of video with a face in view. Missing values hide.
- Timeline: lanes for who's talking, smile (dashed baseline = their usual), facing, nods, and a markers row
  with ✓ follow-ups, amber ⚠ missed moments, red ! awkward moments and numbered takeaway markers, nudged
  apart so they never overlap. Clicking seeks.
- One transcript: Figma `.line` rows, synced to the playhead and auto-scrolled, click to seek. Words are
  tinted only where the heatmap gives them a kind (green = picked up / follow-up / topic / promise / smiling;
  red = awkward / missed / filler / mixed), at most three per line, with the reason on hover. Your lines get a
  reaction chip only when it's notable ("smiled +39, 2 nods", "smile −10, looked away"). Lines where the voice
  separation merged your words into theirs show a "You (merged)" sub-line with its own ⚠ chips. A line with a
  `try` takeaway gets an inline "Try instead" bubble.
- Voice picker: if the server can't tell which voice is yours (409 `needsLabel`, or `userLabel` null), a
  "Which voice is yours?" box sits at the top and nothing is attributed to "you" until a line is tapped.
- Collapsed `<details>` at the bottom: how the coaching note was checked (note + verdict rows), what we picked
  up (no AI), how this works.
- Analysis runs in the browser: MediaPipe Face Landmarker over a hidden video at 5 fps, seek-based, with a
  progress bar; frames (`t, face, smile, yaw, pitch, jawOpen, browUp`) are posted to `/behavior` together with
  `recordingUploadedAt`, and the page ignores stale responses if the video changed.

## 9. Realtime and API the front end relies on

- `WS /ws/stage` broadcasts: `hello {mock, focus}`, `focus {view, conversationId, otherName}`,
  `conversation {conversation}`, `processing {conversationId}`, `partial` / `turn` / `done` while recording,
  `memory`, `deleted {conversationId}`.
- `WS /ws/transcribe?conversationId=` takes PCM frames and returns `ready`, `partial`, `turn`, `done`, `error`.
- REST: `GET /api/memory`, `GET/POST /api/conversations`, `GET /api/conversations/:id`,
  `POST …/user-label`, `POST …/process`, `PATCH …` (retag), `DELETE …`, `GET …/compare`,
  `POST …/follow-up` (`{}` draft, `{regenerate:true}`, `{text}`), `POST …/follow-up/sent {text}`,
  `GET /api/brief?name=`, `POST /api/next-step/:id {action}`, `POST /api/stage/focus`,
  `POST …/recording?offsetMs=` (raw video), `GET …/recording` (ranged), `POST …/behavior`,
  `GET …/behavior/frames`, `POST …/insight`, `GET …/heatmap`, `GET /api/logs`.
- A conversation object carries: `id, tag, otherName, createdAt, turns[{turnId, speaker, text, startMs,
  endMs}], userLabel, reflection, signals, note{text, suggestion, citedTurnIds, status}, hooks{topics,
  events, commitments, missedBids, highlights, followUpDetector, awkward{flags, score, seams}},
  followUp{text, hooksUsed, status, sentAt}, recording, behavior, insight{takeaways, rewrites, moments,
  adviceCheck}`.

## 10. Rules of thumb when adding to it

1. Start from a Figma component; don't invent a new card, label or button style.
2. Build DOM with `el()` and `textContent`; never `innerHTML` with data.
3. Guard every async paint with `stillOn` / a sequence number.
4. Keep the colour meanings (you / them / awkward / missed) and the mono-for-numbers rule.
5. Keep iOS in mind on the phone: audio and share APIs must be called inside the tap.
6. Test on a scratch database on another port; the demo server on :3000 is live.

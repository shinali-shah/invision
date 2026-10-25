# Playback

Most tools only look at what you said. Playback looks at how the other person responded, and helps you
become a better listener over time.

You wear glasses with a mic on them (and optionally point the phone's camera at the other person) during a real conversation. Afterwards you get one specific piece
of advice, backed by the moment it came from: what they said, what you said, and the line that would have landed
better. It remembers people, so next time you get a brief before you talk, and a before/after once you have.

Built at HackTX 2026 on Meta's Muse models.

## What it does

**On the phone (iPhone Safari)**
- **Before:** type who you're about to talk to and get a brief: promises you made, things coming up for them,
  what they lit up about last time. Or skip the name: "Hi Abuela" in the first line fills it in.
- **During:** live, diarized transcript of both voices (English and Spanish, code-switching included), plus video
  if Camera is on. With the camera on, lip movement tells the app which voice is yours and which lines came from
  people in the background, so nobody has to tap. If the transcriber hangs up mid-call, the server reopens it
  where the audio left off. Consent is a required step.
- **After:** a coaching note, a comparison with your last conversation with that person, what the app picked up
  (topics, missed moments, promises), and a drafted follow-up message you can send in one tap.

**On the Mac (`/mac`, one page, two tabs)**
- **Home** is the dashboard: a calendar coloured by how each conversation went, your streak, this week's goals,
  follow-ups still waiting on you, the live transcript while the phone records, and the recent conversations
  with what worked and what to try next.
- **Replay** opens a finished conversation:
  - **3 takeaways:** *Try this next time* (their line, your line, and a rewrite that picks up their words),
    *Keep doing this*, and *Ask about it next time*. Each one has a ▶ that plays the moment.
  - **Moments:** the two to four turns the camera singled out, each with what was said and what their face did.
  - **Score strip:** follow-ups, missed moments, and how they reacted after your follow-ups vs your other lines.
  - **Timeline:** who was talking, their smile, facing and nods, with follow-ups and missed moments marked.
  - **Transcript heatmap:** the few words per line that mattered, each with a reason.
- **Projector view** (`/stage.html`, linked from Home's recording card): follows the phone in real time, big
  enough for a wall.

## Not an LLM wrapper

The measuring is deterministic and explainable; Muse Spark is used where language judgment is needed, and
everything it writes is checked against what was measured.

| Measured without a model | Muse Spark, grounded and validated |
|---|---|
| Questions, talk share, answer length (`src/analysis/rules.js`) | Is this question a follow-up? Cross-checked against the lexical detector; agreement is logged |
| Lexical follow-up detector, EN/ES stems and back-references (`src/nlp/hooks.js`) | Coaching note: a reviewer agent plus a regex guard; every number must exist in the measured signals |
| Topics, upcoming events, your promises, missed bids | Follow-up message: rejected unless it names something real from the conversation |
| Face cues aligned to each turn: reaction after your lines, nods, facing (`src/behavior/align.js`) | "Try instead" rewrites: only accepted if they pick up the other person's words |
| Evidence numbers on every takeaway, before/after deltas, word heatmap, pre-meeting brief | Takeaway wording, pattern and weekly goal |

Face cues come from a pretrained model, MediaPipe Face Landmarker, running in the browser (vendored in
`public/vendor/mediapipe/`). It measures smiling, facing and head movement: observable cues only, never feelings or
sincerity. Insight text that guesses at feelings ("she was bored", "fake smile") is rejected and replaced with the
numbers.

Every agent has a fallback (rule counts, templates, the measured numbers), so a Muse outage never dead-ends the demo.

## Run it

Node 24 or newer. No build step.

```bash
npm install
npm start          # http://localhost:3000 — mock mode until you add a key
npm test           # node:test, no network
```

No `MODEL_API_KEY` means **mock mode**: the transcriber replays a scripted bilingual call and every agent returns
deterministic output, so the whole thing works offline. The phone shows a small "Demo" badge so you know. Two
sample conversations with Abuela are seeded (dated a few days ago, refreshed on every boot) so Home, the brief and
the before/after have something to show before you record anything.

Live mode:

```bash
cp .env.example .env    # then fill MODEL_API_KEY from dev.meta.ai
npm start               # reads .env on its own
ngrok http 3000         # Safari only allows the mic and camera over https
```

- **iPhone:** open the `https://…ngrok…` link (the root page is the phone app), plug in the mic, leave Camera on, record.
- **Mac:** open `http://localhost:3000/mac` (`?theme=dark` for dark rooms). Keys `1` / `2` switch Home and Replay.
  For a big screen open `http://localhost:3000/stage.html` in its own window.
- Something else on 3000? `PORT=3001 npm start`, then `ngrok http 3001`.
- `npm run dev` forces mock mode and restarts on save, key or no key.

| Env | Default | |
|---|---|---|
| `MODEL_API_KEY` | – | Meta Model API key. Empty means mock mode |
| `MOCK` | – | `1` (or `true`) forces mock mode even with a key |
| `PORT` | `3000` | |
| `USER_NAME` | `Parth` | Whose phone it is. "I'm Parth" in the transcript picks your voice; the Mac shows your initials |
| `DEMO_LANGUAGES` | `English,Spanish` | sent as `languageBias` to the transcriber |
| `MUSE_SPARK_MODEL` | `muse-spark-1.3` | |
| `MUSE_ASR_MODEL` | `muse-voice-transcribe-1.0` | |
| `DB_PATH` / `RECORDINGS_DIR` | `data/playback.db` / `data/recordings` | relative to the repo root, created on first use |

## How it fits together

| Step | Code | Meta API |
|---|---|---|
| Record, transcribe, separate voices | `public/pcm-worklet.js` → `WS /ws/transcribe` → `src/transcribe/realtime.js` | Muse Voice Transcribe, `wss://api.meta.ai/v1/asr/realtime`, `DIARIZATION`, PCM 24 kHz |
| Lip lock, reconnect | `public/lips.js` → `src/transcribe/crowd.js`, `wsRoute.js` | – |
| Hooks, follow-up detector | `src/nlp/` | – |
| Classify, coach, review | `src/analysis/classify.js`, `src/agents/coach.js`, `reviewer.js` | Muse Spark, `POST /v1/chat/completions`, strict `json_schema` |
| Follow-up message | `src/agents/followUp.js` | Muse Spark |
| Pattern, weekly goal | `src/agents/patternFinder.js`, `nextStep.js` | Muse Spark |
| Before/after, brief | `src/nlp/compare.js`, `brief.js` | – |
| Video, face cues | `public/replay.js` (MediaPipe) → `POST /behavior` → `src/behavior/align.js` | – |
| Takeaways, moments, rewrites | `src/agents/insight.js` | Muse Spark |
| Heatmap | `src/nlp/heatmap.js` | – |

The follow-up draft and the trend run alongside coaching, so a live conversation is coached in about 25 seconds.

### API

Everything under `/api` answers JSON; the pages come from `public/`. `:id` is a conversation id.

| | |
|---|---|
| `GET /api/health`, `GET /api/me` | `{ok, mock}` and whose phone this is |
| `POST /api/conversations` | start one: `{tag, otherName?, consentConfirmed: true}` |
| `GET /api/conversations`, `GET /api/conversations/:id` | the list (each flagged `needsLabel`) and one |
| `POST …/:id/user-label` | `{label}`: which voice is yours |
| `POST …/:id/process` | coach it; `{reflection?}`. Shares one run with any other caller |
| `PATCH …/:id` | `{tag}` recoaches, `{otherName}` renames |
| `DELETE …/:id` | the row, the video, the face frames and the lip-lock cues |
| `GET …/:id/compare` | before/after against the last time with this person |
| `POST …/:id/follow-up`, `POST …/:id/follow-up/sent` | draft (`{}`), redraft (`{regenerate}`), edit (`{text}`); mark sent |
| `GET /api/brief?name=` | the pre-meeting brief |
| `POST …/:id/recording?offsetMs=`, `GET …/:id/recording` | upload the video (raw `video/mp4` or `webm`); stream it back with ranges |
| `POST …/:id/behavior`, `GET …/:id/behavior/frames` | face frames in, aligned cues and the insight out; the raw frames back |
| `POST …/:id/insight`, `GET …/:id/heatmap` | takeaways without a video; the word heatmap |
| `GET /api/memory`, `POST /api/next-step/:id` | pattern, weekly step and the signal table; `{action: accept\|change\|dismiss}` |
| `POST /api/stage/focus` | the phone tells the Mac which view it is on |
| `GET /api/logs` | the last 100 agent log lines |
| `WS /ws/transcribe?conversationId=` | PCM in, `ready` / `partial` / `turn` / `done` out |
| `WS /ws/stage` | everything the Mac pages listen to |

## Privacy

- Recording needs a consent step on the phone ("I told them I'm recording audio and video").
- The transcription audio only passes through the server's memory and is never written down. With Camera on, the
  video (with its sound) is saved on the Mac in `data/recordings/`, next to the face frames and lip-lock cues.
  Nothing is uploaded anywhere but Meta's transcription and chat endpoints.
- Deleting a conversation (bottom of the coaching screen on the phone) deletes its transcript, notes, video and
  face cues. To start completely clean, stop the server and delete `data/`; the two samples come back on boot.
- Every agent's log line is in the phone's Logs drawer, at `GET /api/logs`, and in the terminal.
- Privacy and terms: the full write-up for the people being recorded is `/legal.html`, linked from the phone's consent line.

## Demo (2 minutes)

1. Type their name: the brief shows on the phone and the Mac.
2. Record a short conversation with the camera on. Stop, tap your own line, get coaching.
3. On the Mac, Replay opens on its own: play the *Try this next time* moment and read the rewrite.
4. Point at the score strip: reactions after follow-ups vs other lines.
5. Send the drafted follow-up from the phone.
6. Talk to the same person again and show the before/after.

## Still open

- Reflection is typed (spoken would be nicer)
- A camera on the glasses too, and a mic placement that catches both people reliably
- Testing the face cues and iOS video recording on more real conversations
- Calendar integration

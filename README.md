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
  what they lit up about last time.
- **During:** live, diarized transcript of both voices (English and Spanish, code-switching included), plus video
  if Camera is on. Consent is a required step.
- **After:** a coaching note, a comparison with your last conversation with that person, what the app picked up
  (topics, missed moments, promises), and a drafted follow-up message you can send in one tap.

**On the Mac (`/mac`, one page, two sections)**
- **Live** follows the phone in real time, big enough for a projector.
- **Replay** opens a finished conversation:
  - **3 takeaways:** *Try this next time* (their line, your line, and a rewrite that picks up their words),
    *Keep doing this*, and *Ask about it next time*. Each one has a ▶ that plays the moment.
  - **Score strip:** follow-ups, missed moments, and how they reacted after your follow-ups vs your other lines.
  - **Timeline:** who was talking, their smile, facing and nods, with follow-ups and missed moments marked.
  - **Transcript heatmap:** the few words per line that mattered, each with a reason.

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

```bash
npm install
npm start          # http://localhost:3000
npm test           # node:test, no network
```

No `MODEL_API_KEY` means **mock mode**: the transcriber replays a scripted bilingual call and every agent returns
deterministic output, so the whole thing works offline.

Live mode:

```bash
cp .env.example .env    # then fill MODEL_API_KEY from dev.meta.ai
node --env-file=.env src/server.js
ngrok http 3000         # Safari only allows the mic and camera over https
```

- **iPhone:** open the `https://…ngrok…` link, plug in the mic, leave Camera on, record.
- **Mac:** open `http://localhost:3000/mac` (`?theme=dark` for dark rooms). Keys `1` / `2` switch Live and Replay.

| Env | Default | |
|---|---|---|
| `MODEL_API_KEY` | – | Meta Model API key. Empty means mock mode |
| `MOCK` | – | `1` forces mock mode even with a key |
| `DEMO_LANGUAGES` | `English,Spanish` | sent as `languageBias` to the transcriber |
| `MUSE_SPARK_MODEL` | `muse-spark-1.3` | |
| `MUSE_ASR_MODEL` | `muse-voice-transcribe-1.0` | |
| `PORT` / `DB_PATH` / `RECORDINGS_DIR` | `3000` / `data/playback.db` / `data/recordings` | |

## Synthetic demo account

To see the app the way it looks after two weeks of use, build the demo account. It is clearly labelled
synthetic: every conversation has `synthetic: true`, and the database is marked as a synthetic dataset.

```bash
npm run synthetic       # writes data/demo.db (never data/playback.db)
npm run dev:synthetic   # serves it: PLAYBACK_DB=demo, mock mode, http://localhost:3000
```

It holds 13 conversations, one a day from Oct 12 to Oct 24 2026, with teammates Prat, Priya and Parth
in strict rotation, all about building Playback. The calendar goes from rough to alright to good, with one
outlier in each stretch:

| Date | Person | Colour | What happens | Outlier |
|---|---|---|---|---|
| Oct 12 | Prat | red | Scope creep: three cut-ins on the Replay timeline, skips past the lip lock struggle | |
| Oct 13 | Priya | red | Rate-limit panic: interrupts the queue explanation, undersells the fallback notes twice | |
| Oct 14 | Parth | yellow | Merge conflict: hedges and one cut-in | |
| Oct 15 | Prat | green | Mock-mode fallback: one strong open question, promises the Replay mockup Thursday | yes |
| Oct 16 | Priya | yellow | Lip-lock filter debate: misses the diarization news, cuts back in | |
| Oct 17 | Parth | green | Mac Live tab: balanced, a follow-up that lands; judging on Saturday | |
| Oct 18 | Prat | yellow | Who presents: two cut-ins and an aside about another team, taken back | |
| Oct 19 | Priya | red | Late night: curt on the face-cue calibration, never asks back | yes |
| Oct 20 | Parth | green | Splitting the work: follow-ups on the palette, promises the heatmap by Friday | |
| Oct 21 | Prat | green | Replay overlay: asks first, listens, summarizes back | |
| Oct 22 | Priya | green | Muse Voice walkthrough: picks up the Friday sponsor demo, offers to help | |
| Oct 23 | Parth | yellow | Rushed bug triage: two cut-ins, a one-word reply | yes |
| Oct 24 | Prat | green | Wrap-up: promises the deck, Prat lights up about realtime dashboards | |

The transcripts are hand-written in `src/synthetic/conversations.js`. `src/synthetic/build.js` runs them
through the real pipeline with the offline mock agents, so signals, awkward flags, colours, notes, follow-ups
and takeaways are all measured; only the "try instead" rewrites for Oct 12, 15 and 19 are hand-written.
One mulberry32 seed, fixed dates, fixed ids and a fixed clock make every build identical. There is no video;
face cues are generated from each conversation's tone and stored per turn. `fixtures/synthetic/demo.json` is
a snapshot of the data (`node src/synthetic/cli.js --db data/snap.db --snapshot`), and
`test/synthetic.test.js` checks the dates, rotation, colours, streak, pending promises and determinism.

## How it fits together

| Step | Code | Meta API |
|---|---|---|
| Record, transcribe, separate voices | `public/pcm-worklet.js` → `WS /ws/transcribe` → `src/transcribe/realtime.js` | Muse Voice Transcribe, `wss://api.meta.ai/v1/asr/realtime`, `DIARIZATION`, PCM 24 kHz |
| Hooks, follow-up detector | `src/nlp/` | – |
| Classify, coach, review | `src/analysis/classify.js`, `src/agents/coach.js`, `reviewer.js` | Muse Spark, `POST /v1/chat/completions`, strict `json_schema` |
| Follow-up message | `src/agents/followUp.js` | Muse Spark |
| Pattern, weekly goal | `src/agents/patternFinder.js`, `nextStep.js` | Muse Spark |
| Before/after, brief | `src/nlp/compare.js`, `brief.js` | – |
| Video, face cues | `public/replay.js` (MediaPipe) → `POST /behavior` → `src/behavior/align.js` | – |
| Takeaways, rewrites | `src/agents/insight.js` | Muse Spark |
| Heatmap | `src/nlp/heatmap.js` | – |

The follow-up draft and the trend run alongside coaching, so a live conversation is coached in about 25 seconds.

## Privacy

- Recording needs a consent step on the phone ("I told them I'm recording audio and video").
- Audio is streamed for transcription and not stored. Video stays on the Mac in `data/recordings/`.
- Deleting a conversation deletes its transcript, notes, video and face cues.

## Demo (2 minutes)

1. Type their name: the brief shows on the phone and the Mac.
2. Record a short conversation with the camera on. Stop, tap your own line, get coaching.
3. On the Mac, Replay opens on its own: play the *Try this next time* moment and read the rewrite.
4. Point at the score strip: reactions after follow-ups vs other lines.
5. Send the drafted follow-up from the phone.
6. Talk to the same person again and show the before/after.

## Still open

- Reflection is typed (spoken would be nicer)
- Mounting the mic and camera on the glasses so they catch both people
- Testing the face cues and iOS video recording on more real conversations
- Calendar integration

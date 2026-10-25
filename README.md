# Playback

Most tools only look at what you said. Playback looks at how the other person responded, and helps you become a better listener over time.

Glasses mic → iPhone web app → **Muse Voice Transcribe** (live diarized transcript, both voices, audio discarded) → rules + **Muse Spark** analysis → one reviewed coaching note → memory view with a trend and a weekly next step.

Plan: `docs/superpowers/plans/2026-10-24-playback.md`

## Run it

```bash
npm install
npm start          # http://localhost:3000
npm test           # node:test, no network
```

No `MODEL_API_KEY` → **mock mode**: the transcriber replays a scripted 30-second bilingual call (English → Spanish) and every Muse Spark agent returns deterministic output. The whole demo works offline and the header shows a "Demo audio" badge.

Live mode:

```bash
cp .env.example .env    # then fill MODEL_API_KEY from dev.meta.ai
node --env-file=.env src/server.js
```

| Env | Default | |
|---|---|---|
| `MODEL_API_KEY` | – | Meta Model API key. Empty = mock mode |
| `MOCK` | – | `1` forces mock mode even with a key |
| `DEMO_LANGUAGES` | `English,Spanish` | sent as `languageBias` to the transcriber |
| `MUSE_SPARK_MODEL` | `muse-spark-1.3` | |
| `MUSE_ASR_MODEL` | `muse-voice-transcribe-1.0` | |
| `PORT` / `DB_PATH` | `3000` / `data/playback.db` | |

### On the iPhone

Safari only gives the page a microphone over https:

```bash
ngrok http 3000
```

Open the `https://…ngrok…` link on the phone. Plug the Saramonic mic in, then tap Record.

### Stage view (the Mac on the projector)

The phone records (the mic is plugged into it); the Mac shows what's happening, live and big.

1. On the Mac: `npm start`, then `ngrok http 3000`.
2. Mac browser: `http://localhost:3000/stage.html` → full screen (`?theme=dark` for dark rooms).
3. iPhone: open the ngrok `https://` link and record as usual.

The stage follows the phone: live transcript while recording, the note + counts + highlighted lines after coaching, the trend and next step when the phone opens Memory. Changing the tag on the phone swaps the note on stage.

## Replay page (camera + behavior cues)

Turn **Camera** on before recording (consent covers audio and video). The phone records video next to the
transcript and uploads it to the Mac when you stop. Open `http://localhost:3000/replay.html` on the Mac:

- **Pretrained model, in the browser:** MediaPipe Face Landmarker (vendored in `public/vendor/mediapipe/`) runs over the
  video at 5 fps and reports smiling, facing and head pose per frame. Observable cues only, never feelings or sincerity.
- **Aligned without AI:** `src/behavior/align.js` lines the cues up with each turn: the other person's reaction in the
  2.5 s after each of your lines, nods, facing, and where upbeat words met a flat face ("mixed").
- **Headline stat:** their reaction after your follow-up questions vs after your other lines.
- **Word heatmap:** `src/nlp/heatmap.js` colours every word: threads you picked up, follow-ups, topics, promises,
  smiles (green), and missed moments, fillers, mixed signals (red), each with its reason.
- **Did the advice hold up?** Muse Spark (`src/agents/insight.js`) checks the coaching note against the cues, picks
  moments to replay, and is rejected (numbers-only fallback) if it claims anything about feelings or cites turns that
  don't exist.

Video stays in `data/recordings/` on the Mac; deleting a conversation deletes its video and cues.

## How it fits together

| Step | Code | Muse API |
|---|---|---|
| Tag + consent | `public/app.js`, `POST /api/conversations` | – |
| Record + transcribe + separate | `public/pcm-worklet.js` → `WS /ws/transcribe` → `src/transcribe/realtime.js` | `wss://api.meta.ai/v1/asr/realtime`, `mode: DIARIZATION`, PCM 24 kHz |
| Analyze | `src/analysis/rules.js` + `classify.js` | `POST /v1/chat/completions`, strict `json_schema` |
| Coach → review | `src/agents/coach.js` → `reviewer.js` | same |
| Remember | `src/agents/patternFinder.js`, `nextStep.js`, `src/pipeline.js` | same |

| Hooks + follow-up detector | `src/nlp/` (no model) | – |
| Follow-up message | `src/agents/followUp.js` (grounded in hooks, checked) | same |
| Before / after | `src/nlp/compare.js`, `GET /api/conversations/:id/compare` | – |
| Pre-meeting brief | `src/nlp/brief.js`, `GET /api/brief?name=` | – |

### What's measured vs. what's generated

The numbers and evidence come from deterministic NLP in `src/nlp/` and `src/analysis/rules.js`; Muse Spark is used where language judgment is actually needed, and every output is checked against what the NLP layer found.

| Deterministic (explainable, works offline) | Muse Spark (grounded + validated) |
|---|---|
| Questions, talk share, answer length | Is this question a follow-up? (cross-checked against the lexical detector, agreement logged) |
| Lexical follow-up detector (EN/ES stems, back-references) | Coaching note (reviewer + regex guard; numbers must exist in signals) |
| Topics, upcoming events, your promises, missed bids | Follow-up message (rejected unless it names a real hook; template fallback) |
| Before/after deltas, "did you follow last note's suggestion" | Pattern + weekly goal |
| Pre-meeting brief | – |

Every agent has the spec's fallback (rule counts only / raw counts / signal table / fixed goals / drop the note), so the demo never dead-ends. Logs for each step are in the app's Logs drawer.

## Demo script (2:00)

- **0:00** One-liner, bilingual hero story.
- **0:15** Tell the teammate you're recording (out loud — that's the consent step). Pick **Family**, tick "I told them".
- **0:25** Record. 30-second conversation that switches languages.
- **0:55** Stop. Tap one of your lines. Show the transcript with labels, the counts and the note with its lines highlighted.
- **1:15** Follow the note: ask a better follow-up, teammate answers live.
- **1:30** Memory: three conversations, the pattern with its numbers. Accept the weekly next step.
- **1:45** Switch the tag to **Networking** on a conversation to show the note adapt.
- **1:55** Close: it coaches you on how people respond to you, not just what you said.

Before demo day: rehearse twice end to end, keep a recording of a good run, and test speaker labels in a noisy room with the glasses mic (Meta reports ~17.5% diarization error; live is worse than recordings).

## Still open (from the spec)

- Reflection typed or spoken (typed for now)
- Second demo language and who speaks it (`DEMO_LANGUAGES`)
- Mounting the mic so it picks up both voices
- Calendar integration (stretch, not built)
- Camera / LED (deferred)

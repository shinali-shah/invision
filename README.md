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

## How it fits together

| Step | Code | Muse API |
|---|---|---|
| Tag + consent | `public/app.js`, `POST /api/conversations` | – |
| Record + transcribe + separate | `public/pcm-worklet.js` → `WS /ws/transcribe` → `src/transcribe/realtime.js` | `wss://api.meta.ai/v1/asr/realtime`, `mode: DIARIZATION`, PCM 24 kHz |
| Analyze | `src/analysis/rules.js` + `classify.js` | `POST /v1/chat/completions`, strict `json_schema` |
| Coach → review | `src/agents/coach.js` → `reviewer.js` | same |
| Remember | `src/agents/patternFinder.js`, `nextStep.js`, `src/pipeline.js` | same |

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

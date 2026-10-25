# Camera, behavior cues and the Replay page — Contract

Goal: learn more from each conversation by lining up what was said with how the other person
reacted, and show on a separate page (the Replay page, on the Mac) where Muse Spark's advice is
backed by what happened on camera.

Ground rules (these are also pitch lines):
- Camera is opt-in per conversation, and the consent box says audio **and video**.
- The pretrained model (MediaPipe Face Landmarker, blendshapes + head pose) measures observable
  cues only: smiling, facing the camera, nodding, how animated the face is. We never claim to read
  sincerity or emotion; "match / mixed" compares what was said with those cues, nothing more.
- Video stays on this Mac (`data/recordings/`), and deleting the conversation deletes it.

## Flow

1. Phone: "Camera" toggle on the start view (default on when a camera exists). When on, getUserMedia
   asks for audio + video (rear camera, `facingMode: 'environment'`, ~640x480, 15 fps). The audio
   track still feeds the existing AudioWorklet → Muse pipeline unchanged. A MediaRecorder records the
   same stream (audio+video; `video/mp4` on iOS, `video/webm` elsewhere, ~1 Mbps).
2. On Stop: the phone uploads the blob, then carries on to the label view as today. Upload failures
   show a retry, never block coaching.
3. Replay page `/replay.html?id=<conversationId>` (Mac): plays the recording, runs Face Landmarker
   over the video **in the browser** (5 frames per second of video, seek-based so it's faster than
   real time), posts the per-frame cues to the server, then shows the aligned view and the
   Spark insight.

## Time base

Transcript `startMs/endMs` are ms of audio since capture start. The recording starts at capture
start too; the phone measures any gap and uploads it as `offsetMs` (video time of transcript 0 =
`offsetMs`). So video seconds = `(turnMs + offsetMs) / 1000`.

## Types

```js
Recording = { mime: string, bytes: number, offsetMs: number, uploadedAt: string }   // on conversation.recording

BehaviorFrame = { t: number /* ms, transcript time base */, face: boolean, smile: number /*0..1*/,
                  yaw: number /*deg*/, pitch: number /*deg*/, jawOpen: number, browUp: number }

// POST body for behavior
BehaviorUpload = { model: string /* e.g. 'mediapipe-face-landmarker@0.10.14' */, fps: number, frames: BehaviorFrame[] }

// Stored as conversation.behavior; built server-side by alignBehavior() — no model involved
Behavior = {
  model, fps, frameCount, faceSeenPct,
  baseline: { smile, animation },                    // mean over frames with a face (the smile score is right-skewed; a median under-reads it)
  turns: [{ turnId, speaker: 'you' | 'them',
            smile, smilePeak, facingPct, nods, animation,     // over the turn's window; null if no face frames
            reaction: { smileDelta, nods, facingPct } | null, // for YOUR turns: their response in the 2.5 s after you stopped
            textTone: 'positive' | 'negative' | 'neutral',     // lexicon, EN+ES
            congruence: 'match' | 'mixed' | null }],          // for THEIR turns: text tone vs smile/animation
  stats: {
    afterFollowUps: { n, smileDelta, nods },           // mean reaction after your follow-up questions
    afterOther:     { n, smileDelta, nods },           // after your other lines
    missedBidReactions: [{ turnId, smileDelta }],      // reaction after your reply to a missed bid
  },
}

Insight = {   // conversation.insight, from Muse Spark, grounded in Behavior + hooks + note, validated
  moments: [{ turnId, title, observation, why }],     // 2-4; every turnId exists; observation cites cues
  adviceCheck: [{ advice: string, verdict: 'backed' | 'partly' | 'not yet', evidenceTurnIds: number[], reason }],
  source: 'muse-spark' | 'fallback',
}
```

## API

- `POST /api/conversations/:id/recording?offsetMs=<n>` raw body (Content-Type video/*), ≤ 200 MB →
  `Recording`. Saved as `data/recordings/<id>.<mp4|webm>`.
- `GET /api/conversations/:id/recording` → the file, with Range support (video seeking).
- `POST /api/conversations/:id/behavior` body `BehaviorUpload` → `{ behavior, insight }`
  (stores Behavior, then asks Muse Spark for the Insight; fallback insight is deterministic).
- `POST /api/conversations/:id/insight` → regenerate the Insight → `Insight`.
- `DELETE /api/conversations/:id` also deletes the recording file.
- Conversation objects gain `recording`, `behavior`, `insight` (all nullable).
- Stage hub: these changes publish `{ type: 'conversation', conversation }` as usual.

// Everything env-driven lives here so the rest of the code never touches process.env.
const env = process.env;
const apiKey = env.MODEL_API_KEY?.trim() || null;
// PLAYBACK_DB=demo serves the synthetic demo account (npm run synthetic) instead of real recordings.
const demo = env.PLAYBACK_DB === 'demo';

const config = Object.freeze({
  apiKey,
  // no key means we can't reach Muse at all, so fall back to the scripted demo
  mock: !apiKey || env.MOCK === '1',
  port: Number(env.PORT) || 3000,
  // Whose phone this is. The transcript's "I'm Parth" picks their voice; anyone else is "them".
  userName: env.USER_NAME?.trim() || 'Parth',
  languages: (env.DEMO_LANGUAGES || 'English,Spanish').split(',').map(s => s.trim()).filter(Boolean),
  sparkModel: env.MUSE_SPARK_MODEL || 'muse-spark-1.3',
  asrModel: env.MUSE_ASR_MODEL || 'muse-voice-transcribe-1.0',
  dbPath: env.DB_PATH || (demo ? 'data/demo.db' : 'data/playback.db'),
  recordingsDir: env.RECORDINGS_DIR || (demo ? 'data/demo-recordings' : 'data/recordings'),
});

export default config;

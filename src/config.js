// Everything env-driven lives here so the rest of the code never touches process.env.

// "1", "true", "yes" and "on" all mean yes; a typo'd MOCK=true used to run live without saying so.
const flag = v => /^(1|true|yes|on)$/i.test((v ?? '').trim());

// A port that isn't a number (or isn't one a server can listen on) falls back to 3000.
function portOf(v) {
  const n = Number.parseInt(v, 10);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : 3000;
}

export function readConfig(env = process.env) {
  const apiKey = env.MODEL_API_KEY?.trim() || null;
  return Object.freeze({
    apiKey,
    // no key means we can't reach Muse at all, so fall back to the scripted demo
    mock: !apiKey || flag(env.MOCK),
    port: portOf(env.PORT),
    // Whose phone this is. The transcript's "I'm Parth" picks their voice; anyone else is "them".
    userName: env.USER_NAME?.trim() || 'Parth',
    languages: (env.DEMO_LANGUAGES || 'English,Spanish').split(',').map(s => s.trim()).filter(Boolean),
    sparkModel: env.MUSE_SPARK_MODEL || 'muse-spark-1.3',
    asrModel: env.MUSE_ASR_MODEL || 'muse-voice-transcribe-1.0',
    // Both are relative to the repo root; the folders are created on first use.
    dbPath: env.DB_PATH || 'data/playback.db',
    recordingsDir: env.RECORDINGS_DIR || 'data/recordings',
  });
}

const config = readConfig();

export default config;

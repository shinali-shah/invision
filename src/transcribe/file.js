const FILE_URL = 'https://api.meta.ai/v1/asr/transcribe';

// Fallback when the realtime socket isn't an option: one diarized pass over a WAV.
export async function transcribeWav({ apiKey, model, languages, wav, fetchImpl = fetch, timeoutMs = 120000 }) {
  const form = new FormData();
  form.append('request', JSON.stringify({ model, audioEncoding: 'WAV', mode: 'DIARIZATION', languageBias: languages }));
  form.append('audio', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');

  const res = await fetchImpl(FILE_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    body: form,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Muse file transcribe: HTTP ${res.status} ${detail.slice(0, 200)}`);
  }

  const body = await res.json();
  return (body.turns ?? [])
    .map(t => ({ turnId: t.turnId, speaker: t.speaker ?? 'unknown', text: (t.transcript ?? '').trim(), startMs: t.startMs, endMs: t.endMs }))
    .filter(t => t.text);
}

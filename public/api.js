// Thin fetch wrapper. Every failure becomes an Error with a message that's
// safe to put straight on screen.

async function request(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error("Couldn't reach the server. Check the connection and try again.");
  }
  if (res.status === 204) return null;
  let data = null;
  try { data = await res.json(); } catch { /* empty or non-JSON body */ }
  if (!res.ok) {
    throw new Error((data && data.error) || `Server said ${res.status}. Try again.`);
  }
  return data;
}

const enc = encodeURIComponent;

export const api = {
  health: () => request('GET', '/api/health'),
  createConversation: ({ tag, otherName }) =>
    request('POST', '/api/conversations', { tag, otherName, consentConfirmed: true }),
  setUserLabel: (id, label) => request('POST', `/api/conversations/${enc(id)}/user-label`, { label }),
  process: (id, reflection) => request('POST', `/api/conversations/${enc(id)}/process`, { reflection }),
  retag: (id, tag) => request('PATCH', `/api/conversations/${enc(id)}`, { tag }),
  remove: (id) => request('DELETE', `/api/conversations/${enc(id)}`),
  memory: () => request('GET', '/api/memory'),
  nextStep: (id, action, text) =>
    request('POST', `/api/next-step/${enc(id)}`, text === undefined ? { action } : { action, text }),
  logs: () => request('GET', '/api/logs'),
};

export function transcribeSocketUrl(conversationId) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws/transcribe?conversationId=${enc(conversationId)}`;
}

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

// Raw video body, so not request(). XHR rather than fetch because fetch can't
// report upload progress. Resolves to the server's Recording. The promise carries an
// abort() for when the conversation is deleted while the video is still going up.
function uploadRecording(id, blob, offsetMs, onProgress) {
  const xhr = new XMLHttpRequest();
  const done = new Promise((resolve, reject) => {
    xhr.open('POST', `/api/conversations/${enc(id)}/recording?offsetMs=${enc(Math.round(offsetMs) || 0)}`);
    xhr.setRequestHeader('Content-Type', (blob.type || 'video/mp4').split(';')[0]);
    if (onProgress) {
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    }
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch { /* empty or non-JSON body */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error((data && data.error) || `Server said ${xhr.status}. Try again.`));
    };
    xhr.onerror = () => reject(new Error("Couldn't reach the server to save the video."));
    xhr.onabort = () => reject(new Error('Upload cancelled.'));
    xhr.send(blob);
  });
  done.abort = () => { try { xhr.abort(); } catch { /* already finished */ } };
  return done;
}

export const api = {
  health: () => request('GET', '/api/health'),
  createConversation: ({ tag, otherName }) =>
    request('POST', '/api/conversations', { tag, otherName, consentConfirmed: true }),
  me: () => request('GET', '/api/me'),
  setUserLabel: (id, label) => request('POST', `/api/conversations/${enc(id)}/user-label`, { label }),
  setOtherName: (id, otherName) => request('PATCH', `/api/conversations/${enc(id)}`, { otherName }),
  process: (id, reflection) => request('POST', `/api/conversations/${enc(id)}/process`, { reflection }),
  retag: (id, tag) => request('PATCH', `/api/conversations/${enc(id)}`, { tag }),
  remove: (id) => request('DELETE', `/api/conversations/${enc(id)}`),
  memory: () => request('GET', '/api/memory'),
  nextStep: (id, action, text) =>
    request('POST', `/api/next-step/${enc(id)}`, text === undefined ? { action } : { action, text }),
  logs: () => request('GET', '/api/logs'),
  getCompare: (id) => request('GET', `/api/conversations/${enc(id)}/compare`),
  // {} drafts one if there isn't one, { regenerate: true } rewrites, { text } saves an edit.
  followUp: (id, body = {}) => request('POST', `/api/conversations/${enc(id)}/follow-up`, body),
  markFollowUpSent: (id, text) => request('POST', `/api/conversations/${enc(id)}/follow-up/sent`, text ? { text } : {}),
  getBrief: (name) => request('GET', `/api/brief?name=${enc(name)}`),
  uploadRecording,
  // Tells the projector page which screen the phone is on. Fire and forget:
  // the stage is a nice-to-have, so it never gets to break the phone flow.
  stageFocus: (view, conversationId, otherName) => {
    try {
      const body = { view, conversationId: conversationId ?? null };
      if (otherName) body.otherName = otherName;
      fetch('/api/stage/focus', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        keepalive: true,
      }).catch(() => {});
    } catch { /* never mind */ }
  },
};

export function transcribeSocketUrl(conversationId) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws/transcribe?conversationId=${enc(conversationId)}`;
}

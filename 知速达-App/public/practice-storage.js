export const sessionKey = id => "zhisuda.practice." + id;
export function readSession(id) {
  try { const data = JSON.parse(localStorage.getItem(sessionKey(id))); return data?.version === 1 ? data : null; }
  catch { return null; }
}
export function writeSession(id, data) {
  localStorage.setItem(sessionKey(id), JSON.stringify({ ...data, version: 1, savedAt: Date.now() }));
}

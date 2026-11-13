export const MAX_BODY = 500;
export const MAX_NAME = 40;
export const LIFETIME_DAYS = 100;
export const HIDE_AT_REPORTS = 3;
export const POSTS_PER_HOUR = 5;

const LINK = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|io|co|ly|me|xyz|ru|gg|app|dev|link|site|info|biz|tk)\b)/i;
const blocked = (process.env.BLOCKED_WORDS || '')
  .split(',').map(w => w.trim().toLowerCase()).filter(Boolean);

export const wrapLng = x => (x >= -180 && x <= 180 ? x : ((((x + 180) % 360) + 360) % 360) - 180);

// Returns { error } or { letter } with cleaned fields.
export function validateLetter(input) {
  const body = typeof input?.body === 'string' ? input.body.trim() : '';
  const name = typeof input?.name === 'string' ? input.name.trim() : '';
  const lat = Number(input?.lat), lng = Number(input?.lng);
  if (!body) return { error: 'Write something first.' };
  if (body.length > MAX_BODY) return { error: `Keep it under ${MAX_BODY} characters.` };
  if (name.length > MAX_NAME) return { error: `Name must be under ${MAX_NAME} characters.` };
  if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng)) return { error: 'Pick a spot on the map.' };
  if (LINK.test(body) || LINK.test(name)) return { error: 'Links are not allowed.' };
  const text = (body + ' ' + name).toLowerCase();
  if (blocked.some(w => text.includes(w))) return { error: 'That letter contains a blocked word.' };
  return { letter: { body, name, lat, lng: wrapLng(lng) } };
}

// SQL fragment + params for the visible map area. Handles the 180° line.
export function boundsFilter(q) {
  let [w, s, e, n] = ['w', 's', 'e', 'n'].map(k => Number(q?.[k]));
  if (![w, s, e, n].every(Number.isFinite)) return { sql: '1=1', params: [] };
  const lat = 'lat BETWEEN ? AND ?';
  if (e - w >= 360) return { sql: lat, params: [s, n] };
  w = wrapLng(w); e = wrapLng(e);
  return w <= e
    ? { sql: `${lat} AND lng BETWEEN ? AND ?`, params: [s, n, w, e] }
    : { sql: `${lat} AND (lng >= ? OR lng <= ?)`, params: [s, n, w, e] };
}

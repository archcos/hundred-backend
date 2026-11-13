export const MAX_BODY = 500;
export const MAX_REPLY = 300;
export const MAX_NAME = 40;
export const LIFETIME_DAYS = 100;
export const HIDE_AT_REPORTS = 3;
export const POSTS_PER_HOUR = Number(process.env.POSTS_PER_HOUR ?? 5); // 0 = no limit
export const FONTS = ['hand', 'type', 'serif', 'neat'];
export const PAPERS = ['cream', 'airmail', 'rose', 'mint', 'kraft'];

const LINK = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|io|co|ly|me|xyz|ru|gg|app|dev|link|site|info|biz|tk)\b)/i;

// Public letter ids are random UUIDs (crypto.randomUUID), so links can't be guessed or counted through.
export const isUuid = s => typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

export const wrapLng = x => (x >= -180 && x <= 180 ? x : ((((x + 180) % 360) + 360) % 360) - 180);

// ---- Blocked words ----
// Text is normalised before matching: lowercase, accents and zero-width characters removed,
// common leetspeak undone (0→o 1→i 3→e 4→a 5→s 7→t @→a $→s).
const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's' };
export const normalize = t => String(t).normalize('NFKD').replace(/\p{M}/gu, '').replace(/[​-‍⁠﻿]/g, '')
  .toLowerCase().replace(/[013457@$]/g, c => LEET[c]);
const esc = c => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// One regex for the whole list. Each word matches as a whole word (so "ass" never blocks "class"),
// with repeated letters ("niiice") and spacing/punctuation between letters ("s p a m", "s.p.a.m").
// Endings: words of 5+ letters also match s/es/ed/ing/er/ers; short words only a plural "s",
// because short words plus endings collide with real words ("spic" + "y" = "spicy").
export function blockedPattern(words) {
  const parts = [...new Set(words.map(w => normalize(w).trim()).filter(Boolean))].map(w => {
    const body = w.split(/\s+/).map(word => [...word].map(c => `${esc(c)}+`).join('[\\W_]*')).join('[\\W_]+');
    const last = w.split(/\s+/).pop();
    return `${body}${last.length >= 5 ? '(?:s|es|ed|ing|ers?)?' : 's?'}`;
  });
  return parts.length ? new RegExp(`(?<![a-z])(?:${parts.join('|')})(?![a-z])`, 'u') : null;
}

// Shared checks for letters and replies. Returns { error } or { body, name }.
// `blocked` is the compiled pattern from blockedPattern() (or null for none).
function validateText(input, max, blocked = null) {
  const body = typeof input?.body === 'string' ? input.body.trim() : '';
  const name = typeof input?.name === 'string' ? input.name.trim() : '';
  if (!body) return { error: 'Write something first.' };
  if (body.length > max) return { error: `Keep it under ${max} characters.` };
  if (name.length > MAX_NAME) return { error: `Name must be under ${MAX_NAME} characters.` };
  if (LINK.test(body) || LINK.test(name)) return { error: 'Links are not allowed.' };
  if (blocked?.test(normalize(`${body} ${name}`))) return { error: 'That contains a blocked word.' };
  return { body, name };
}

// Returns { error } or { letter } with cleaned fields. Unknown font/paper fall back to the defaults.
export function validateLetter(input, blocked) {
  const t = validateText(input, MAX_BODY, blocked);
  if (t.error) return t;
  const lat = Number(input?.lat), lng = Number(input?.lng);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng)) return { error: 'Pick a spot on the map.' };
  const font = FONTS.includes(input?.font) ? input.font : FONTS[0];
  const paper = PAPERS.includes(input?.paper) ? input.paper : PAPERS[0];
  return { letter: { body: t.body, name: t.name, lat, lng: wrapLng(lng), font, paper } };
}

export function validateReply(input, blocked) {
  const t = validateText(input, MAX_REPLY, blocked);
  return t.error ? t : { reply: { body: t.body, name: t.name } };
}

// Auto-moderation. Every new letter/reply is scanned; matches are flagged for the admin.
// hold: true means it stays hidden until an admin approves it.
const digits = s => (s.match(/\d/g) || []).length;
const FLAG_RULES = [
  { flag: 'personal-info', hold: true, test: t => /[\w.+-]+@[\w-]+\.[a-z]{2,}/i.test(t) || (t.match(/\+?\d[\d\s().-]{7,}\d/g) || []).some(m => digits(m) >= 9) },
  { flag: 'code', hold: true, test: t => /<\s*\/?\s*(script|iframe|img|svg|object|embed|style|a|form|input|link|meta)\b|javascript:|\bon(error|load|click|mouse\w*|focus|blur)\s*=|\{\{|\$\{/i.test(t) },
  { flag: 'hidden-link', hold: true, test: t => /\b(dot|\(dot\)|\[dot\])\s*(com|net|org|io|xyz|me)\b|h\s+t\s+t\s+p|\w\s*[[(]\s*\.\s*[\])]\s*\w/i.test(t) },
  { flag: 'garbled', hold: true, test: t => (t.match(/\p{M}/gu) || []).length > 15 },
  { flag: 'threat', hold: false, test: t => /\b(kill|murder|bomb|shoot|stab|terror\w*|rape|massacre|gun)s?\b/i.test(t) },
  { flag: 'self-harm', hold: false, test: t => /\b(suicid\w*|kill (my|him|her)self|end my life|want to die|self[- ]?harm)\b/i.test(t) },
  { flag: 'spam', hold: false, test: t => {
    const letters = t.replace(/[^a-z]/gi, '');
    const shouty = letters.length > 20 && letters.replace(/[^A-Z]/g, '').length / letters.length > 0.7;
    return shouty || /(.)\1{9,}/.test(t) || /\b(\w+)\b(\W+\1\b){4,}/i.test(t);
  } },
];
export function autoFlags(text) {
  const hits = FLAG_RULES.filter(r => r.test(String(text)));
  return { flags: hits.map(r => r.flag), held: hits.some(r => r.hold) };
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

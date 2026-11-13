import express from 'express';
import mysql from 'mysql2/promise';
import crypto from 'node:crypto';
import { validateLetter, validateReply, boundsFilter, isUuid, autoFlags, blockedPattern, LIFETIME_DAYS, HIDE_AT_REPORTS, POSTS_PER_HOUR } from './lib.js';
import { DEFAULT_BLOCKED_WORDS } from './blocklist.js';
import { createTranslator, isLangCode } from './translate.js';

const { DATABASE_URL, ADMIN_TOKEN = '', ADMIN_USERNAME = 'admin', IP_SALT = '', WEB_ORIGIN = 'http://localhost:3100', PORT = 5100, TRUST_PROXY } = process.env;
if (!DATABASE_URL) throw new Error('Set DATABASE_URL in server/.env');

const db = mysql.createPool({ uri: DATABASE_URL, charset: 'utf8mb4' });
await db.query(`CREATE TABLE IF NOT EXISTS letters (
  id INT AUTO_INCREMENT PRIMARY KEY,
  lat DOUBLE NOT NULL, lng DOUBLE NOT NULL,
  body VARCHAR(500) NOT NULL, name VARCHAR(40) NOT NULL DEFAULT '',
  ip_hash CHAR(64) NOT NULL,
  reports INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX (created_at), INDEX (lat, lng), INDEX (ip_hash, created_at)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
// Columns added after launch. Works on MySQL and MariaDB; "duplicate column" means it's already there.
const addColumn = (table, col) => db.query(`ALTER TABLE ${table} ADD COLUMN ${col}`).catch(e => { if (e.code !== 'ER_DUP_FIELDNAME') throw e; });
await addColumn('letters', `font VARCHAR(10) NOT NULL DEFAULT 'hand'`);
await addColumn('letters', `paper VARCHAR(10) NOT NULL DEFAULT 'cream'`);
// Public id: a random UUID per letter. The numeric id stays internal (joins, admin).
await addColumn('letters', 'uid CHAR(36) NULL');
const [missing] = await db.query('SELECT id FROM letters WHERE uid IS NULL');
for (const { id } of missing) await db.query('UPDATE letters SET uid = ? WHERE id = ?', [crypto.randomUUID(), id]);
await db.query('ALTER TABLE letters ADD UNIQUE INDEX uid_unique (uid)').catch(e => { if (e.code !== 'ER_DUP_KEYNAME') throw e; });
await db.query(`CREATE TABLE IF NOT EXISTS reports (
  letter_id INT NOT NULL, ip_hash CHAR(64) NOT NULL,
  PRIMARY KEY (letter_id, ip_hash),
  FOREIGN KEY (letter_id) REFERENCES letters(id) ON DELETE CASCADE
)`);
// Replies disappear with their letter (cascade), so the 100-day rule covers them too.
await db.query(`CREATE TABLE IF NOT EXISTS replies (
  id INT AUTO_INCREMENT PRIMARY KEY,
  letter_id INT NOT NULL,
  body VARCHAR(300) NOT NULL, name VARCHAR(40) NOT NULL DEFAULT '',
  ip_hash CHAR(64) NOT NULL,
  reports INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX (letter_id), INDEX (ip_hash, created_at),
  FOREIGN KEY (letter_id) REFERENCES letters(id) ON DELETE CASCADE
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
await db.query(`CREATE TABLE IF NOT EXISTS reply_reports (
  reply_id INT NOT NULL, ip_hash CHAR(64) NOT NULL,
  PRIMARY KEY (reply_id, ip_hash),
  FOREIGN KEY (reply_id) REFERENCES replies(id) ON DELETE CASCADE
)`);

// Auto-moderation (flags = comma list from autoFlags; held = hidden until an admin approves)
// and report reasons/times for the admin Reports tab.
for (const t of ['letters', 'replies']) {
  await addColumn(t, `flags VARCHAR(100) NOT NULL DEFAULT ''`);
  await addColumn(t, 'held TINYINT NOT NULL DEFAULT 0');
}
for (const t of ['reports', 'reply_reports']) {
  await addColumn(t, `reason VARCHAR(20) NOT NULL DEFAULT 'other'`);
  await addColumn(t, 'created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP');
  await addColumn(t, 'dismissed TINYINT NOT NULL DEFAULT 0'); // dismissing keeps the report, it just stops counting
}

// NO DELETE: admins can only archive (hide) and restore. There is deliberately no route that deletes a
// letter or reply, so a stolen admin password can't destroy anything. The only permanent removal is the
// automatic 100-day expiry below. See README.md.
for (const t of ['letters', 'replies']) await addColumn(t, 'archived_at DATETIME NULL');

// Append-only record of every admin action. No route edits or deletes it.
await db.query(`CREATE TABLE IF NOT EXISTS admin_log (
  id INT AUTO_INCREMENT PRIMARY KEY,
  at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  action VARCHAR(30) NOT NULL, kind VARCHAR(10) NOT NULL DEFAULT '', item_id INT NULL,
  detail VARCHAR(255) NOT NULL DEFAULT '', ip_hash CHAR(64) NOT NULL,
  INDEX (at)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);

// Translations: one saved result per letter/reply and language, so each is translated at most once per language.
// `same` = the text was already in the requested language (nothing to show). Derived data, cleaned up with the expiry job.
await db.query(`CREATE TABLE IF NOT EXISTS translations (
  item_type VARCHAR(8) NOT NULL, item_id INT NOT NULL, lang VARCHAR(12) NOT NULL,
  text TEXT NOT NULL, from_lang VARCHAR(12) NOT NULL DEFAULT '', same TINYINT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (item_type, item_id, lang)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
const translator = createTranslator(); // null when no provider is configured in .env
console.log(translator ? `Translation: ${translator.name}` : 'Translation: off (set DEEPL_API_KEY, GOOGLE_TRANSLATE_API_KEY or LIBRETRANSLATE_URL to turn it on)');
const translateHits = new Map(); // ip hash -> timestamps, an in-memory limiter (see translateAllowed)

// Monthly character budget for the translation service, so a busy month can't run past a free allowance
// (DeepL Free and Google both give about 500,000 characters a month). TRANSLATE_MONTHLY_LIMIT=0 means no limit.
const MONTHLY_LIMIT = Number(process.env.TRANSLATE_MONTHLY_LIMIT ?? 400000);
const budgetKey = () => `translate_chars_${new Date().toISOString().slice(0, 7)}`;
const BUDGET_MSG = 'Translation is resting until next month.';
async function checkBudget(chars) {
  if (!(MONTHLY_LIMIT > 0)) return;
  const [[row]] = await db.query('SELECT v FROM meta WHERE k = ?', [budgetKey()]);
  if (Number(row?.v || 0) + chars > MONTHLY_LIMIT) throw Object.assign(new Error(BUDGET_MSG), { budget: true });
}
const spend = chars => db.query('INSERT INTO meta (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = v + ?', [budgetKey(), String(chars), chars]);
// Every route that calls the provider answers a budget stop with 429 and any other failure with 502.
const translateFailure = (res, e, fallback) => {
  if (e.budget) return res.status(429).json({ error: BUDGET_MSG });
  console.error('translate failed:', e.message);
  return res.status(502).json({ error: fallback });
};

// Moderation: banned authors (by salted IP hash) and blocked words managed from the admin panel.
await db.query(`CREATE TABLE IF NOT EXISTS bans (
  ip_hash CHAR(64) PRIMARY KEY, reason VARCHAR(200) NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
await db.query(`CREATE TABLE IF NOT EXISTS blocked_words (word VARCHAR(60) PRIMARY KEY) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
await db.query(`CREATE TABLE IF NOT EXISTS meta (k VARCHAR(40) PRIMARY KEY, v VARCHAR(200) NOT NULL)`);
// Load the starter blocklist once. Afterwards the admin panel owns the list (removed words stay removed).
const [[seeded]] = await db.query(`SELECT v FROM meta WHERE k = 'blocklist_seeded'`);
if (!seeded) {
  await db.query('INSERT IGNORE INTO blocked_words (word) VALUES ?', [DEFAULT_BLOCKED_WORDS.map(w => [w])]);
  await db.query(`INSERT INTO meta (k, v) VALUES ('blocklist_seeded', ?)`, [new Date().toISOString()]);
  console.log(`Loaded ${DEFAULT_BLOCKED_WORDS.length} starter blocked words.`);
}
const ENV_WORDS = (process.env.BLOCKED_WORDS || '').split(',').map(w => w.trim().toLowerCase()).filter(Boolean);
let blockedWords = blockedPattern(ENV_WORDS); // compiled regex (or null), rebuilt whenever the list changes
const loadBlocked = async () => {
  const [rows] = await db.query('SELECT word FROM blocked_words');
  blockedWords = blockedPattern([...ENV_WORDS, ...rows.map(r => r.word)]);
};
await loadBlocked();

// The 100-day rule: delete hourly, and never serve anything older anyway.
// This automatic expiry (archived letters included) is the ONLY thing that permanently deletes content.
const purge = async () => {
  try {
    await db.query('DELETE FROM letters WHERE created_at < NOW() - INTERVAL ? DAY', [LIFETIME_DAYS]);
    // Saved translations are derived data: drop the ones whose letter or reply is gone.
    await db.query(`DELETE t FROM translations t
      LEFT JOIN letters l ON t.item_type = 'letters' AND l.id = t.item_id
      LEFT JOIN replies r ON t.item_type = 'replies' AND r.id = t.item_id
      WHERE (t.item_type = 'letters' AND l.id IS NULL) OR (t.item_type = 'replies' AND r.id IS NULL)`);
    translateHits.clear();
  } catch (e) { console.error(e); }
};
purge(); setInterval(purge, 60 * 60 * 1000);

const app = express();
if (TRUST_PROXY) app.set('trust proxy', Number(TRUST_PROXY) || TRUST_PROXY); // set to 1 behind Render/Railway/nginx
app.use(express.json({ limit: '64kb' })); // room for /api/letters/alive id lists; letters are length-checked separately
// WEB_ORIGIN can be one address or several, comma-separated. Browsers only accept ONE origin in this header,
// so reply with the caller's origin when it's on the list (otherwise the first one).
const ALLOWED_ORIGINS = WEB_ORIGIN.split(',').map(o => o.trim().replace(/\/$/, '')).filter(Boolean);
app.use((req, res, next) => {
  const origin = req.get('origin');
  res.set({
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    Vary: 'Origin',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST',
  });
  req.method === 'OPTIONS' ? res.sendStatus(204) : next();
});

// :uid = public letter UUID; :id = internal number (admin, replies).
app.param('uid', (req, res, next, uid) => isUuid(uid) ? next() : res.status(404).json({ error: 'This letter has faded away.' }));
app.param('id', (req, res, next, id) => /^\d{1,10}$/.test(id) ? next() : res.status(400).json({ error: 'Bad id.' }));

// Store a salted hash, never the raw IP.
const ipHash = req => crypto.createHash('sha256').update(IP_SALT + req.ip).digest('hex');
const fresh = `created_at >= NOW() - INTERVAL ${LIFETIME_DAYS} DAY`;
const ageCol = 'TIMESTAMPDIFF(SECOND, created_at, NOW()) / 86400 AS age_days';
const visible = `${fresh} AND reports < ${HIDE_AT_REPORTS} AND held = 0 AND archived_at IS NULL`;
const REPORT_REASONS = ['spam', 'abuse', 'personal', 'danger', 'other'];
const reasonOf = body => (REPORT_REASONS.includes(body?.reason) ? body.reason : 'other');
const PUBLIC = `uid AS id, lat, lng, body, name, font, paper, ${ageCol}`; // the public never sees the numeric id

// Letters and replies share one hourly budget per person.
async function overLimit(ip) {
  if (!(POSTS_PER_HOUR > 0)) return false;
  const [[{ n }]] = await db.query(`SELECT
    (SELECT COUNT(*) FROM letters WHERE ip_hash = ? AND created_at > NOW() - INTERVAL 1 HOUR) +
    (SELECT COUNT(*) FROM replies WHERE ip_hash = ? AND created_at > NOW() - INTERVAL 1 HOUR) AS n`, [ip, ip]);
  return n >= POSTS_PER_HOUR;
}
const TOO_MANY = { error: 'You have written a lot this hour. Try again later.' };

// Returns [status, body] if this person may not post right now, else null.
async function postBlock(ip) {
  const [[ban]] = await db.query('SELECT 1 AS b FROM bans WHERE ip_hash = ?', [ip]);
  if (ban) return [403, { error: "You can't post right now." }];
  if (await overLimit(ip)) return [429, TOO_MANY];
  return null;
}

app.get('/api/letters', async (req, res) => {
  const { sql, params } = boundsFilter(req.query);
  // ponytail: newest 500 in view; add clustering or server-side grid if a view ever holds more
  const [rows] = await db.query(`SELECT ${PUBLIC} FROM letters WHERE ${visible} AND ${sql} ORDER BY id DESC LIMIT 500`, params);
  res.json(rows);
});

// Which of these ids are still on the map (not faded, deleted or hidden by reports).
// The site sends its read list so the unread count stays exact.
app.post('/api/letters/alive', async (req, res) => {
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).filter(isUuid).slice(0, 1500);
  if (!ids.length) return res.json({ ids: [] });
  const [rows] = await db.query(`SELECT uid FROM letters WHERE ${visible} AND uid IN (?)`, [ids]);
  res.json({ ids: rows.map(r => r.uid) });
});

// ?exclude=uuid,uuid skips letters the reader already has (up to 150 ids, keeps the URL short).
app.get('/api/letters/random', async (req, res) => {
  const exclude = String(req.query.exclude || '').split(',').filter(isUuid).slice(0, 150);
  const skip = exclude.length ? 'AND uid NOT IN (?)' : '';
  // ponytail: ORDER BY RAND() scans every row; fine to ~100k letters, then pick a random id instead
  const [[row]] = await db.query(`SELECT ${PUBLIC} FROM letters WHERE ${visible} ${skip} ORDER BY RAND() LIMIT 1`, exclude.length ? [exclude] : []);
  row ? res.json(row) : res.status(404).json({ error: 'No letters yet.' });
});

app.get('/api/letters/:uid', async (req, res) => {
  const [[row]] = await db.query(`SELECT ${PUBLIC} FROM letters WHERE uid = ? AND ${visible}`, [req.params.uid]);
  row ? res.json(row) : res.status(404).json({ error: 'This letter has faded away.' });
});

// ---------- Translation (a reader presses "Translate"; nothing is translated automatically) ----------
// At most 60 translate requests per person per 10 minutes. Results are saved, so repeats cost nothing.
const translateAllowed = ip => {
  const now = Date.now(), hits = (translateHits.get(ip) || []).filter(t => now - t < 600e3);
  if (hits.length >= 60) { translateHits.set(ip, hits); return false; }
  hits.push(now); translateHits.set(ip, hits); return true;
};

// items: [{ type: 'letters' | 'replies', id, body }] -> Map "type:id" -> { text, from, same }. Saved ones come from the
// database; the rest go to the provider in one batch and are saved.
async function translateItems(items, lang) {
  const key = lang.toLowerCase(), out = new Map();
  const ids = type => items.filter(i => i.type === type).map(i => i.id);
  const cached = [];
  for (const type of ['letters', 'replies']) {
    if (!ids(type).length) continue;
    const [rows] = await db.query('SELECT item_type, item_id, text, from_lang, same FROM translations WHERE item_type = ? AND lang = ? AND item_id IN (?)', [type, key, ids(type)]);
    cached.push(...rows);
  }
  for (const r of cached) out.set(`${r.item_type}:${r.item_id}`, { text: r.text, from: r.from_lang, same: !!r.same });
  const todo = items.filter(i => !out.has(`${i.type}:${i.id}`));
  if (todo.length) {
    const chars = todo.reduce((n, i) => n + i.body.length, 0);
    await checkBudget(chars);
    const results = await translator.translateMany(todo.map(i => i.body), lang);
    await spend(chars);
    const rows = todo.map((i, n) => {
      const r = results[n] ?? { text: '', from: '', same: false };
      out.set(`${i.type}:${i.id}`, { text: r.same ? '' : r.text, from: r.from, same: r.same });
      return [i.type, i.id, key, r.same ? '' : r.text, r.from || '', r.same ? 1 : 0];
    });
    await db.query('INSERT IGNORE INTO translations (item_type, item_id, lang, text, from_lang, same) VALUES ?', [rows]);
  }
  return out;
}

// Which languages readers can translate into (whatever the configured provider supports).
app.get('/api/translate/languages', async (req, res) => {
  res.json(translator ? { enabled: true, languages: await translator.languages() } : { enabled: false, languages: [] });
});

// Translate a letter and its replies into `lang` in one request.
app.post('/api/letters/:uid/translate', async (req, res) => {
  if (!translator) return res.status(501).json({ error: 'Translation is not set up on this site.' });
  const lang = req.body?.lang;
  if (!isLangCode(lang)) return res.status(400).json({ error: 'Pick a language.' });
  if (!translateAllowed(ipHash(req))) return res.status(429).json({ error: 'You are translating a lot. Try again in a few minutes.' });
  const [[letter]] = await db.query(`SELECT id, body FROM letters WHERE uid = ? AND ${visible}`, [req.params.uid]);
  if (!letter) return res.status(404).json({ error: 'This letter has faded away.' });
  const [replies] = await db.query(`SELECT id, body FROM replies WHERE letter_id = ? AND reports < ? AND held = 0 AND archived_at IS NULL ORDER BY id LIMIT 200`, [letter.id, HIDE_AT_REPORTS]);
  try {
    const got = await translateItems([{ type: 'letters', id: letter.id, body: letter.body }, ...replies.map(r => ({ type: 'replies', id: r.id, body: r.body }))], lang);
    res.json({ lang, provider: translator.name, letter: got.get(`letters:${letter.id}`),
      replies: Object.fromEntries(replies.map(r => [r.id, got.get(`replies:${r.id}`)])) });
  } catch (e) { translateFailure(res, e, "The translation service couldn't translate that. Try again, or pick another language."); }
});

// Total count + hotspots: ~100 km grid cells holding 2 or more letters, each with its most-used paper.
app.get('/api/stats', async (req, res) => {
  // ponytail: groups every visible letter on each call; cache this for a minute if traffic gets heavy
  const [rows] = await db.query(`SELECT ROUND(lat) AS cy, ROUND(lng) AS cx, paper, COUNT(*) AS n, SUM(lat) AS slat, SUM(lng) AS slng
    FROM letters WHERE ${visible} GROUP BY cy, cx, paper`);
  const cells = new Map();
  let total = 0;
  for (const r of rows) {
    const n = Number(r.n); total += n;
    const c = cells.get(`${r.cy},${r.cx}`) || { cy: Number(r.cy), cx: Number(r.cx), n: 0, slat: 0, slng: 0, paper: r.paper, top: 0 };
    c.n += n; c.slat += Number(r.slat); c.slng += Number(r.slng);
    if (n > c.top) { c.top = n; c.paper = r.paper; }
    cells.set(`${r.cy},${r.cx}`, c);
  }
  const hotspots = [...cells.values()].filter(c => c.n >= 2).sort((a, b) => b.n - a.n).slice(0, 10)
    .map(c => ({ lat: c.slat / c.n, lng: c.slng / c.n, n: c.n, paper: c.paper, cell: `${c.cy},${c.cx}` })); // cell = ROUND(lat),ROUND(lng)
  res.json({ total, hotspots, translate: !!translator });
});

app.post('/api/letters', async (req, res) => {
  const { error, letter } = validateLetter(req.body, blockedWords);
  if (error) return res.status(400).json({ error });
  const ip = ipHash(req);
  const block = await postBlock(ip);
  if (block) return res.status(block[0]).json(block[1]);
  const uid = crypto.randomUUID();
  const { flags, held } = autoFlags(`${letter.body} ${letter.name}`);
  await db.query('INSERT INTO letters (uid, lat, lng, body, name, font, paper, ip_hash, flags, held) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [uid, letter.lat, letter.lng, letter.body, letter.name, letter.font, letter.paper, ip, flags.join(','), held ? 1 : 0]);
  res.status(201).json({ id: uid, ...letter, age_days: 0, held });
});

app.post('/api/letters/:uid/report', async (req, res) => {
  const [[letter]] = await db.query('SELECT id FROM letters WHERE uid = ?', [req.params.uid]);
  if (!letter) return res.json({ ok: true });
  const [r] = await db.query('INSERT IGNORE INTO reports (letter_id, ip_hash, reason) VALUES (?, ?, ?)', [letter.id, ipHash(req), reasonOf(req.body)]);
  if (r.affectedRows) await db.query('UPDATE letters SET reports = reports + 1 WHERE id = ?', [letter.id]);
  res.json({ ok: true });
});

app.get('/api/letters/:uid/replies', async (req, res) => {
  // ponytail: first 200 replies; paginate if a letter ever gets more
  const [rows] = await db.query(`SELECT r.id, r.body, r.name, TIMESTAMPDIFF(SECOND, r.created_at, NOW()) / 86400 AS age_days
    FROM replies r JOIN letters l ON l.id = r.letter_id
    WHERE l.uid = ? AND r.reports < ? AND r.held = 0 AND r.archived_at IS NULL ORDER BY r.id LIMIT 200`, [req.params.uid, HIDE_AT_REPORTS]);
  res.json(rows);
});

app.post('/api/letters/:uid/replies', async (req, res) => {
  const { error, reply } = validateReply(req.body, blockedWords);
  if (error) return res.status(400).json({ error });
  const [[letter]] = await db.query(`SELECT id FROM letters WHERE uid = ? AND ${visible}`, [req.params.uid]);
  if (!letter) return res.status(404).json({ error: 'This letter has faded away.' });
  const ip = ipHash(req);
  const block = await postBlock(ip);
  if (block) return res.status(block[0]).json(block[1]);
  const { flags, held } = autoFlags(`${reply.body} ${reply.name}`);
  const [r] = await db.query('INSERT INTO replies (letter_id, body, name, ip_hash, flags, held) VALUES (?, ?, ?, ?, ?, ?)',
    [letter.id, reply.body, reply.name, ip, flags.join(','), held ? 1 : 0]);
  res.status(201).json({ id: r.insertId, ...reply, age_days: 0, held });
});

app.post('/api/replies/:id/report', async (req, res) => {
  const id = Number(req.params.id);
  const [r] = await db.query('INSERT IGNORE INTO reply_reports (reply_id, ip_hash, reason) SELECT id, ?, ? FROM replies WHERE id = ?', [ipHash(req), reasonOf(req.body), id]);
  if (r.affectedRows) await db.query('UPDATE replies SET reports = reports + 1 WHERE id = ?', [id]);
  res.json({ ok: true });
});

// ---------- Admin ----------
// Login is HTTP Basic: ADMIN_USERNAME + ADMIN_TOKEN (the password). 10 wrong tries locks that IP out for 15 minutes.
// ponytail: lockout lives in memory (resets on restart, per server); move it to the DB if you run several servers
const failures = new Map(); // ip -> { n, until }
const sha = s => crypto.createHash('sha256').update(String(s)).digest();
const ADMIN_MIN = 16;
if (ADMIN_TOKEN.length < ADMIN_MIN) console.warn(`⚠ Admin login is OFF: ADMIN_TOKEN in server/.env must be at least ${ADMIN_MIN} characters (it is ${ADMIN_TOKEN.length}).`);
app.use('/api/admin', (req, res, next) => {
  if (ADMIN_TOKEN.length < ADMIN_MIN) {
    return res.status(503).json({ error: `Admin login is turned off: the password (ADMIN_TOKEN in server/.env) must be at least ${ADMIN_MIN} characters. Change it and restart the API.` });
  }
  const now = Date.now(), f = failures.get(req.ip);
  if (f?.until > now) return res.status(429).json({ error: 'Too many failed logins. Try again in 15 minutes.' });
  if (f?.until) failures.delete(req.ip);
  const m = /^Basic (.+)$/.exec(req.get('authorization') || '');
  const [user = '', ...rest] = m ? Buffer.from(m[1], 'base64').toString().split(':') : [];
  // `&` (not &&) so both comparisons always run: no timing hint about which part was wrong.
  const ok = (crypto.timingSafeEqual(sha(user), sha(ADMIN_USERNAME)) & crypto.timingSafeEqual(sha(rest.join(':')), sha(ADMIN_TOKEN)));
  if (ok) { failures.delete(req.ip); return next(); }
  const n = (failures.get(req.ip)?.n || 0) + 1;
  failures.set(req.ip, { n, until: n >= 10 ? now + 15 * 60e3 : 0 });
  res.status(401).json({ error: 'Wrong username or password.' });
});

const H = HIDE_AT_REPORTS;
const notArchived = 'archived_at IS NULL';

// Every admin action is recorded. Append-only: no route edits or deletes this log.
const logAdmin = (req, action, kind = '', itemId = null, detail = '') =>
  db.query('INSERT INTO admin_log (action, kind, item_id, detail, ip_hash) VALUES (?, ?, ?, ?, ?)',
    [action, kind, itemId, String(detail).slice(0, 255), ipHash(req)]).catch(console.error);

app.get('/api/admin/overview', async (req, res) => {
  const both = where => `(SELECT COUNT(*) FROM letters WHERE ${where}) + (SELECT COUNT(*) FROM replies WHERE ${where})`;
  const [[o]] = await db.query(`SELECT
    (SELECT COUNT(*) FROM letters WHERE ${visible}) AS live,
    (SELECT COUNT(*) FROM replies WHERE ${notArchived}) AS replies,
    ${both('created_at > NOW() - INTERVAL 1 DAY')} AS today,
    ${both(`held = 1 AND ${notArchived}`)} AS held,
    ${both(`flags <> '' AND ${notArchived}`)} AS flagged,
    ${both(`reports > 0 AND ${notArchived}`)} AS reported,
    ${both(`reports >= ${H} AND ${notArchived}`)} AS hidden,
    ${both('archived_at IS NOT NULL')} AS archived,
    (SELECT COUNT(*) FROM bans) AS bans`);
  res.json({ ...Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Number(v)])), postsPerHour: POSTS_PER_HOUR, hideAt: H, user: ADMIN_USERNAME });
});

// Open (not dismissed) reports grouped per letter/reply, newest first, with every reason given.
app.get('/api/admin/reports', async (req, res) => {
  const cols = t => `${t}.id, ${t}.body, ${t}.name, ${t}.reports, ${t}.held, ${t}.flags, ${t}.archived_at, LEFT(${t}.ip_hash, 8) AS author,
    COUNT(*) AS n, GROUP_CONCAT(rp.reason) AS reasons, MAX(rp.created_at) AS last_at`;
  const [letters] = await db.query(`SELECT 'letters' AS kind, l.uid, ${cols('l')}
    FROM reports rp JOIN letters l ON l.id = rp.letter_id WHERE rp.dismissed = 0 GROUP BY l.id`);
  const [replies] = await db.query(`SELECT 'replies' AS kind, l.uid, ${cols('r')}
    FROM reply_reports rp JOIN replies r ON r.id = rp.reply_id JOIN letters l ON l.id = r.letter_id WHERE rp.dismissed = 0 GROUP BY r.id`);
  res.json([...letters, ...replies].sort((a, b) => new Date(b.last_at) - new Date(a.last_at)).slice(0, 200));
});

app.get('/api/admin/log', async (req, res) => {
  const [rows] = await db.query(`SELECT id, at, action, kind, item_id, detail, LEFT(ip_hash, 8) AS by_ip FROM admin_log ORDER BY id DESC LIMIT 300`);
  res.json(rows);
});

app.get('/api/admin/bans', async (req, res) => {
  const [rows] = await db.query('SELECT ip_hash AS hash, LEFT(ip_hash, 8) AS author, reason, created_at FROM bans ORDER BY created_at DESC');
  res.json(rows);
});
app.post('/api/admin/bans/:hash/unban', async (req, res) => {
  if (!/^[0-9a-f]{64}$/.test(req.params.hash)) return res.status(400).json({ error: 'Bad ban id.' });
  const [r] = await db.query('DELETE FROM bans WHERE ip_hash = ?', [req.params.hash]);
  if (r.affectedRows) logAdmin(req, 'unban', '', null, `author ${req.params.hash.slice(0, 8)}`);
  res.json({ ok: true });
});

app.get('/api/admin/words', async (req, res) => {
  const [rows] = await db.query('SELECT word FROM blocked_words ORDER BY word');
  res.json({ words: rows.map(r => r.word), env: ENV_WORDS });
});
const cleanWord = body => String(body?.word || '').trim().toLowerCase();
app.post('/api/admin/words', async (req, res) => {
  const word = cleanWord(req.body);
  if (!word || word.length > 60 || word.includes(',')) return res.status(400).json({ error: 'Enter one word or phrase (up to 60 characters).' });
  const [r] = await db.query('INSERT IGNORE INTO blocked_words (word) VALUES (?)', [word]);
  if (r.affectedRows) logAdmin(req, 'block-word', '', null, word);
  await loadBlocked();
  res.status(201).json({ ok: true });
});
app.post('/api/admin/words/remove', async (req, res) => {
  const word = cleanWord(req.body);
  const [r] = await db.query('DELETE FROM blocked_words WHERE word = ?', [word]);
  if (r.affectedRows) logAdmin(req, 'unblock-word', '', null, word);
  await loadBlocked();
  res.json({ ok: true });
});

// Letters and replies share the same moderation routes: /api/admin/letters/... and /api/admin/replies/...
const KINDS = {
  letters: { table: 'letters', reports: 'reports', fk: 'letter_id' },
  replies: { table: 'replies', reports: 'reply_reports', fk: 'reply_id' },
};
app.param('kind', (req, res, next, kind) => (KINDS[kind] ? next() : res.status(404).json({ error: 'Not found.' })));
// Moderators: read a post in English. Languages the blocked-word list doesn't understand (Japanese, Arabic…)
// can only be checked by a person, so this is how an admin reads them.
app.post('/api/admin/:kind/:id/translate', async (req, res) => {
  if (!translator) return res.status(501).json({ error: 'Translation is not set up. Add a provider key to server/.env.' });
  const kind = req.params.kind, id = Number(req.params.id);
  const [[row]] = await db.query(`SELECT id, body FROM ${KINDS[kind].table} WHERE id = ?`, [id]);
  if (!row) return res.status(404).json({ error: 'Not found.' });
  try {
    const got = await translateItems([{ type: kind, id, body: row.body }], 'en');
    res.json({ provider: translator.name, ...got.get(`${kind}:${id}`) });
  } catch (e) { translateFailure(res, e, "The translation service couldn't translate that."); }
});

const snippet = async (kind, id) => {
  const [[row]] = await db.query(`SELECT LEFT(body, 80) AS b FROM ${KINDS[kind].table} WHERE id = ?`, [id]);
  return row ? `“${row.b}”` : '';
};

// ?filter=held|flagged|reported|hidden|archived  ?q=text  ?author=8-char tag. Archived items only show under "archived".
function adminWhere(q, t) {
  const w = [q.filter === 'archived' ? `${t}.archived_at IS NOT NULL` : `${t}.archived_at IS NULL`], params = [];
  const filter = { held: `${t}.held = 1`, flagged: `${t}.flags <> ''`, reported: `${t}.reports > 0`, hidden: `${t}.reports >= ${H}` }[q.filter];
  if (filter) w.push(filter);
  if (typeof q.q === 'string' && q.q.trim()) {
    const like = `%${q.q.trim().slice(0, 100).replace(/[\\%_]/g, '\\$&')}%`;
    w.push(`(${t}.body LIKE ? OR ${t}.name LIKE ?)`); params.push(like, like);
  }
  if (/^[0-9a-f]{8}$/.test(q.author || '')) { w.push(`LEFT(${t}.ip_hash, 8) = ?`); params.push(q.author); }
  return { sql: `WHERE ${w.join(' AND ')}`, params };
}

app.get('/api/admin/:kind', async (req, res) => {
  const t = req.params.kind === 'letters' ? 'l' : 'r';
  const { sql, params } = adminWhere(req.query, t);
  const common = `${t}.id, ${t}.body, ${t}.name, ${t}.reports, ${t}.flags, ${t}.held, ${t}.archived_at, LEFT(${t}.ip_hash, 8) AS author,
    ${t}.created_at, TIMESTAMPDIFF(SECOND, ${t}.created_at, NOW()) / 86400 AS age_days`;
  // ponytail: newest 200 matches; add paging when moderation queues get longer
  // Default is newest first. ?sort=attention puts held / flagged / most-reported items on top instead.
  const order = req.query.sort === 'attention'
    ? `ORDER BY ${t}.held DESC, (${t}.flags <> '') DESC, ${t}.reports DESC, ${t}.created_at DESC, ${t}.id DESC LIMIT 200`
    : `ORDER BY ${t}.created_at DESC, ${t}.id DESC LIMIT 200`;
  const [rows] = await db.query(req.params.kind === 'letters'
    ? `SELECT ${common}, l.uid, l.lat, l.lng, l.font, l.paper, (SELECT COUNT(*) FROM replies x WHERE x.letter_id = l.id) AS replies
       FROM letters l ${sql} ${order}`
    : `SELECT ${common}, l.uid, LEFT(l.body, 80) AS letter_body FROM replies r JOIN letters l ON l.id = r.letter_id ${sql} ${order}`,
  params);
  res.json(rows);
});

// Archive = hide from the public; restore = show again. Nothing is deleted.
const setArchived = async (req, kind, ids, archive) => {
  const [r] = await db.query(`UPDATE ${KINDS[kind].table} SET archived_at = ${archive ? 'NOW()' : 'NULL'}
    WHERE id IN (?) AND archived_at IS ${archive ? 'NULL' : 'NOT NULL'}`, [ids]);
  if (r.affectedRows) {
    const detail = ids.length === 1 ? await snippet(kind, ids[0]) : `${r.affectedRows} items: #${ids.join(', #')}`;
    logAdmin(req, archive ? 'archive' : 'restore', kind, ids.length === 1 ? ids[0] : null, detail);
  }
  return r.affectedRows;
};
app.post('/api/admin/:kind/:id/archive', async (req, res) => res.json({ changed: await setArchived(req, req.params.kind, [Number(req.params.id)], true) }));
app.post('/api/admin/:kind/:id/restore', async (req, res) => res.json({ changed: await setArchived(req, req.params.kind, [Number(req.params.id)], false) }));
app.post('/api/admin/:kind/bulk', async (req, res) => {
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).filter(n => Number.isInteger(n) && n > 0).slice(0, 500);
  if (!ids.length || !['archive', 'restore'].includes(req.body?.action)) return res.status(400).json({ error: 'Pick items and an action.' });
  res.json({ changed: await setArchived(req, req.params.kind, ids, req.body.action === 'archive') });
});

// Approve: publish a held item and clear its auto-flags (the flags are kept in the activity log).
app.post('/api/admin/:kind/:id/approve', async (req, res) => {
  const k = KINDS[req.params.kind], id = Number(req.params.id);
  const [[row]] = await db.query(`SELECT flags, LEFT(body, 60) AS b FROM ${k.table} WHERE id = ?`, [id]);
  await db.query(`UPDATE ${k.table} SET held = 0, flags = '' WHERE id = ?`, [id]);
  if (row) logAdmin(req, 'approve', req.params.kind, id, `“${row.b}” flags: ${row.flags || 'none'}`);
  res.json({ ok: true });
});

// Dismiss reports: they stop counting (un-hiding the item) but stay stored.
app.post('/api/admin/:kind/:id/clear-reports', async (req, res) => {
  const k = KINDS[req.params.kind], id = Number(req.params.id);
  const [r] = await db.query(`UPDATE ${k.reports} SET dismissed = 1 WHERE ${k.fk} = ? AND dismissed = 0`, [id]);
  await db.query(`UPDATE ${k.table} SET reports = 0 WHERE id = ?`, [id]);
  logAdmin(req, 'dismiss-reports', req.params.kind, id, `${r.affectedRows} report(s) ${await snippet(req.params.kind, id)}`);
  res.json({ ok: true });
});

// Ban the author of this item. { reason, archiveAll: true } also archives (not deletes) everything they posted.
app.post('/api/admin/:kind/:id/ban', async (req, res) => {
  const [[row]] = await db.query(`SELECT ip_hash FROM ${KINDS[req.params.kind].table} WHERE id = ?`, [Number(req.params.id)]);
  if (!row) return res.status(404).json({ error: 'Not found.' });
  const reason = String(req.body?.reason || '').slice(0, 200);
  await db.query('INSERT INTO bans (ip_hash, reason) VALUES (?, ?) ON DUPLICATE KEY UPDATE reason = VALUES(reason)', [row.ip_hash, reason]);
  let archived = 0;
  if (req.body?.archiveAll) {
    for (const t of ['replies', 'letters']) {
      const [r] = await db.query(`UPDATE ${t} SET archived_at = NOW() WHERE ip_hash = ? AND archived_at IS NULL`, [row.ip_hash]);
      archived += r.affectedRows;
    }
  }
  logAdmin(req, 'ban', req.params.kind, Number(req.params.id), `author ${row.ip_hash.slice(0, 8)}${reason ? ` (${reason})` : ''}${archived ? `, archived ${archived} post(s)` : ''}`);
  res.json({ ok: true, archived });
});

app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'Something went wrong.' }); });
app.listen(PORT, () => console.log(`API on http://localhost:${PORT}`));

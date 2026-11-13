import express from 'express';
import mysql from 'mysql2/promise';
import crypto from 'node:crypto';
import { validateLetter, boundsFilter, LIFETIME_DAYS, HIDE_AT_REPORTS, POSTS_PER_HOUR } from './lib.js';

const { DATABASE_URL, ADMIN_TOKEN = '', IP_SALT = '', WEB_ORIGIN = 'http://localhost:3000', PORT = 4100, TRUST_PROXY } = process.env;
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
await db.query(`CREATE TABLE IF NOT EXISTS reports (
  letter_id INT NOT NULL, ip_hash CHAR(64) NOT NULL,
  PRIMARY KEY (letter_id, ip_hash),
  FOREIGN KEY (letter_id) REFERENCES letters(id) ON DELETE CASCADE
)`);

// The 100-day rule: delete hourly, and never serve anything older anyway.
const purge = () => db.query('DELETE FROM letters WHERE created_at < NOW() - INTERVAL ? DAY', [LIFETIME_DAYS]).catch(console.error);
purge(); setInterval(purge, 60 * 60 * 1000);

const app = express();
if (TRUST_PROXY) app.set('trust proxy', Number(TRUST_PROXY) || TRUST_PROXY); // set to 1 behind Render/Railway/nginx
app.use(express.json({ limit: '4kb' }));
app.use((req, res, next) => {
  res.set({ 'Access-Control-Allow-Origin': WEB_ORIGIN, 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET, POST, DELETE' });
  req.method === 'OPTIONS' ? res.sendStatus(204) : next();
});

app.param('id', (req, res, next, id) => /^\d{1,10}$/.test(id) ? next() : res.status(400).json({ error: 'Bad letter id.' }));

// Store a salted hash, never the raw IP.
const ipHash = req => crypto.createHash('sha256').update(IP_SALT + req.ip).digest('hex');
const fresh = `created_at >= NOW() - INTERVAL ${LIFETIME_DAYS} DAY`;
const ageCol = 'TIMESTAMPDIFF(SECOND, created_at, NOW()) / 86400 AS age_days';

app.get('/api/letters', async (req, res) => {
  const { sql, params } = boundsFilter(req.query);
  // ponytail: newest 500 in view; add clustering or server-side grid if a view ever holds more
  const [rows] = await db.query(
    `SELECT id, lat, lng, body, name, ${ageCol} FROM letters
     WHERE ${fresh} AND reports < ? AND ${sql} ORDER BY id DESC LIMIT 500`, [HIDE_AT_REPORTS, ...params]);
  res.json(rows);
});

app.post('/api/letters', async (req, res) => {
  const { error, letter } = validateLetter(req.body);
  if (error) return res.status(400).json({ error });
  const ip = ipHash(req);
  const [[{ n }]] = await db.query('SELECT COUNT(*) AS n FROM letters WHERE ip_hash = ? AND created_at > NOW() - INTERVAL 1 HOUR', [ip]);
  if (n >= POSTS_PER_HOUR) return res.status(429).json({ error: 'You have sent a lot of letters. Try again in an hour.' });
  const [r] = await db.query('INSERT INTO letters (lat, lng, body, name, ip_hash) VALUES (?, ?, ?, ?, ?)',
    [letter.lat, letter.lng, letter.body, letter.name, ip]);
  res.status(201).json({ id: r.insertId, ...letter, age_days: 0 });
});

app.post('/api/letters/:id/report', async (req, res) => {
  const id = Number(req.params.id);
  const [r] = await db.query('INSERT IGNORE INTO reports (letter_id, ip_hash) SELECT id, ? FROM letters WHERE id = ?', [ipHash(req), id]);
  if (r.affectedRows) await db.query('UPDATE letters SET reports = reports + 1 WHERE id = ?', [id]);
  res.json({ ok: true });
});

// Admin: send "Authorization: Bearer <ADMIN_TOKEN>".
const sha = s => crypto.createHash('sha256').update(s).digest();
const admin = (req, res, next) => {
  const given = (req.get('authorization') || '').replace(/^Bearer /, '');
  if (ADMIN_TOKEN.length >= 16 && crypto.timingSafeEqual(sha(given), sha(ADMIN_TOKEN))) return next();
  res.status(401).json({ error: 'Wrong admin password.' });
};

app.get('/api/admin/letters', admin, async (req, res) => {
  const [rows] = await db.query(`SELECT id, lat, lng, body, name, reports, ${ageCol} FROM letters
    WHERE ${fresh} ORDER BY reports DESC, id DESC LIMIT 300`);
  res.json(rows);
});

app.delete('/api/admin/letters/:id', admin, async (req, res) => {
  await db.query('DELETE FROM letters WHERE id = ?', [Number(req.params.id)]);
  res.json({ ok: true });
});

app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'Something went wrong.' }); });
app.listen(PORT, () => console.log(`API on http://localhost:${PORT}`));

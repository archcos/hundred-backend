# Hundred Day Letters — API

Express + MySQL backend for Hundred Day Letters: a world map where anyone can leave a letter at any
place. Every letter fades and disappears after 100 days.

## There is no delete

**Admins cannot delete letters or replies.** This is deliberate, so that a stolen or misused admin
password can't destroy anything.

- **Archive instead of delete.** Archiving hides a letter or reply from the public. It can be restored
  at any time from the admin panel (**Letters → Archived**). Archiving a letter also hides its replies.
- **No delete routes exist.** The API has no endpoint that deletes a letter or reply, and it refuses
  HTTP `DELETE` requests altogether, so a delete can't be triggered even by calling the API directly.
- **Bans can archive, not delete.** "Ban author" can optionally *archive* everything that author
  posted. All of it can be restored.
- **Dismissing reports keeps them.** Reports are marked as dismissed (they stop counting) but stay stored.
- **Everything is logged.** Every admin action (archive, restore, approve, dismiss reports, ban, unban,
  block/unblock word) is written to `admin_log`, with the time and the hashed connection that did it.
  No route can edit or delete this log. You can see it in the admin panel's **Activity** tab.
- **The only permanent deletion is automatic.** Letters older than 100 days (archived ones included) are
  removed by the hourly expiry job, which is the core promise of the site. Their replies and reports go
  with them.

Settings-type actions (unban, unblock a word) remove a row from the `bans` / `blocked_words` tables.
They don't touch any content, they're logged, and you can undo them by banning or blocking again.

> This protects against a compromised **admin account**. Anyone with direct access to the server or
> database can still change anything, so keep the database password and server access private.

## Running locally

Needs Node 22+ and MySQL/MariaDB (XAMPP works).

```bash
cp .env.example .env   # then fill it in
npm install
npm run dev            # http://localhost:5100
npm test
```

Tables are created and migrated automatically on start.

## Settings (`.env`)

| Variable | What it does |
|---|---|
| `DATABASE_URL` | `mysql://user:password@host:3306/letters` |
| `ADMIN_USERNAME` | Admin login username |
| `ADMIN_TOKEN` | Admin login password, **at least 16 characters** (admin login is off otherwise) |
| `IP_SALT` | Long random string used to hash visitor IPs (raw IPs are never stored) |
| `WEB_ORIGIN` | The website's address, e.g. `https://your-site.com` (only this site may call the API). Several addresses are allowed, comma-separated: `http://localhost:3100,http://192.168.1.20:3100` |
| `PORT` | Port to listen on (default 5100) |
| `POSTS_PER_HOUR` | Letters + replies one person can post per hour, `0` = no limit |
| `BLOCKED_WORDS` | Extra comma-separated blocked words (the rest are managed in the admin panel) |
| `DEEPL_API_KEY` / `GOOGLE_TRANSLATE_API_KEY` / `LIBRETRANSLATE_URL` | Optional. Set one to show a **Translate** button on letters and replies (see Translation below) |
| `TRUST_PROXY` | Set to `1` behind a proxy (Render, Railway, nginx) so rate limits see real IPs |

## Moderation, briefly

- **Blocked words** are refused when posting, matched as whole words; spacing, leetspeak and plurals
  are caught too. A starter list is loaded once on first start, then the admin panel owns it.
- **Auto-flagging** scans every new post. Phone numbers, emails, code, disguised links and garbled text
  are *held* until an admin approves them. Possible threats, self-harm mentions and spam are posted
  but flagged for review.
- **Reports** from visitors carry a reason. 3 reports hide an item until an admin reviews it.
- **Admin login** uses a username and password, with a 15-minute lockout after 10 failed attempts.

## Translation

Readers press **Translate** on a letter to read it in their own language; nothing is translated automatically.
Set one of `DEEPL_API_KEY`, `GOOGLE_TRANSLATE_API_KEY` or `LIBRETRANSLATE_URL` in `.env` to turn it on (with none set, the button is hidden).

- **All languages:** the site asks the service which languages it supports, so readers can choose any of them.
- **Saved:** each letter or reply is translated at most once per language; the result is kept (and removed with the letter at 100 days). The service is only called when someone presses the button, and each person is limited to 60 translations per 10 minutes.
- **Cost:** letters are at most 500 characters (replies 300). DeepL's free plan allows 500,000 characters a month, roughly 3,000 average-length letters (about 100 a day), and each is only counted once because results are saved. Past that, either pay or self-host LibreTranslate.
- **Moderation:** the blocked-word list and auto-flags only understand English. In the admin panel every letter and reply has **Translate to English** in its menu, so a moderator can read posts in other languages.
- **Monthly budget:** `TRANSLATE_MONTHLY_LIMIT` (default 400,000 characters) stops translation before a free allowance runs out; readers then see "Translation is resting until next month".
- **Privacy:** the text of the letter is sent to the translation service you choose.

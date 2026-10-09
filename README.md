![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)
![Node](https://img.shields.io/badge/node-20-green)
![TypeScript](https://img.shields.io/badge/TypeScript-5-blue)
![Framework](https://img.shields.io/badge/Express-4-lightgrey)
![Docker](https://img.shields.io/badge/docker-supported-blue)

# 📎 Telegram File Link Bot

A small, self-hosted **file-to-direct-link service**. Send a file to the **Telegram bot** (or upload it on the web page) and get back a **public download link** with optional **time-based expiry**, **per-IP rate limiting**, and an **admin dashboard** to manage every link.

It is a Node.js / TypeScript (Express) app that runs as a single container, with no database or cache to set up.

> **Origin:** forked from the original *Telegram File Link Bot* by Aman (Apache 2.0). The original was a Python / FastAPI bot backed by PostgreSQL, Redis and S3. **This fork has been rewritten** in Node.js / TypeScript: the bot, web app and admin dashboard now run as one process, and **PostgreSQL, Redis and S3 are no longer used.** See [NOTICE](NOTICE) and [LICENSE](LICENSE).

---

## ✨ Features

### 🤖 Telegram bot
- Send the bot a file and it replies with a direct download link
- Supports documents, videos, audio, photos, animations, voice messages and video notes
- Send images as **File** to keep the original quality
- Uses Telegram's MTProto API (`API_ID` / `API_HASH`), so files up to Telegram's own limit can be received
- Optional private mode: only the Telegram user IDs in `ALLOWED_USER_IDS` can use it
- Several uploads at once are queued (`MAX_CONCURRENT_TRANSFERS`)
- Live download progress in the chat and on the admin dashboard

Commands:

| Command | What it does |
|---|---|
| `/start` | Welcome message |
| `/mode` | Show your current default expiry |
| `/mode ttl 30` | Your uploads expire after 30 minutes |
| `/mode ttl 2h` | ...after 2 hours |
| `/mode ttl 1d` | ...after 1 day (maximum is 30 days) |
| `/mode ttl 0` or `/mode reset` | Your uploads never expire |

Each user's expiry setting is saved and survives restarts.

The bot only starts when `API_ID`, `API_HASH` and `BOT_TOKEN` are all set. Otherwise the web app runs on its own.

### 🔗 Upload & direct links
- Drag-and-drop upload page at `/` with a live progress bar
- Every upload gets a unique ID and a public link: `https://your-domain.com/file/<id>`
- The original filename is preserved on download
- Maximum upload size is configurable (`MAX_FILE_MB`, default 500 MB)

### ⏳ Expiry (TTL only)
- Optional expiry per file, set at upload time or later from the dashboard
- Accepted formats: `30` (minutes), `2h` (hours), `1d` (days), `0` (never expires)
- Expiry is time-based only. There are no download limits
- Expired files are purged from disk automatically (background check every 30 seconds)

### 🚦 Rate limiting
- Global per-IP limit on the download route
- Returns HTTP `429` with `retry_after` when exceeded
- Real client IP is read from `CF-Connecting-IP` or `X-Forwarded-For` when present
- Downloads are counted once per IP per file per hour

### 📊 Admin dashboard (optional)
Enabled with `ADMIN_ENABLED=true`, served at `/admin`.

- Session-based login (email + password, bcrypt-hashed)
- Totals: files, downloads, active files
- Search files by name
- Top downloads, recent uploads, and files about to expire
- Per file: **freeze** (disable the link but keep the file), **rescue** (re-enable and clear expiry), **set expiry**, **delete**
- Files whose data is missing from disk are flagged
- Settings page with storage usage

If `ADMIN_ENABLED=false`, the admin routes are not registered at all.

---

## 🔐 Admin credentials

There are **no default credentials**. The admin account is created at startup **only if both `ADMIN_EMAIL` and `ADMIN_PASSWORD` are set**.

- If either is missing or empty, no admin account exists and **every login is rejected** with "Invalid credentials". A warning is printed in the container log.
- If `SESSION_SECRET` is missing, a random secret is generated at startup (and a warning is logged). Sessions then reset on every restart. Set a long random value to keep sessions across restarts.

---

## ⚙️ Environment variables

Copy `.env.example` to `.env` and fill in the values.

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` (`8000` in Docker) | Port the server listens on |
| `BASE_URL` | request host | Public URL used in download links, e.g. `https://files.example.com` (`https://` is added if you leave it out) |
| `API_ID` | *(none)* | Telegram API ID from <https://my.telegram.org> |
| `API_HASH` | *(none)* | Telegram API hash from <https://my.telegram.org> |
| `BOT_TOKEN` | *(none)* | Bot token from [@BotFather](https://t.me/BotFather) |
| `ALLOWED_USER_IDS` | *(none)* | Comma-separated Telegram user IDs allowed to use the bot. **If empty, anyone can use the bot** |
| `MAX_CONCURRENT_TRANSFERS` | `3` | Bot uploads processed at the same time |
| `SESSION_DIR` | `session` | Folder where the bot keeps its login and per-user settings |
| `ADMIN_ENABLED` | `true` | Turn the admin dashboard on or off |
| `ADMIN_EMAIL` | *(none)* | Admin login email |
| `ADMIN_PASSWORD` | *(none)* | Admin login password |
| `SESSION_SECRET` | random per start | Secret used to sign session cookies |
| `MAX_FILE_MB` | `500` | Maximum upload size in MB (web and bot) |
| `GLOBAL_RATE_LIMIT_REQUESTS` | `60` | Requests allowed per window per IP (`0` disables the limit) |
| `GLOBAL_RATE_LIMIT_WINDOW` | `10` | Rate-limit window in seconds |

---

## ▶️ Running locally

Requires Node.js 20+.

```bash
npm install
cp .env.example .env     # then set ADMIN_EMAIL, ADMIN_PASSWORD, SESSION_SECRET and the bot variables
npm run dev              # http://localhost:3000
```

Production build:

```bash
npm run build
npm start
```

---

## 🐳 Running with Docker

```bash
docker build -t file-link-gateway .
docker run -d --env-file .env -p 8000:8000 -v uploads_data:/app/uploads -v session_data:/app/session file-link-gateway
```

### Docker Compose

The included `docker-compose.yml` builds the image and exposes port `8000` to a reverse proxy. Uploaded files are stored in the `uploads_data` volume, and the bot's login and settings in the `session_data` volume. **Keep the session volume** so the bot does not log in from scratch on every restart.

> **Important:** a variable in `.env` is **not** automatically passed into the container. Compose only uses `.env` to fill in `${...}` references, so every setting must appear under `environment:` (as `ADMIN_EMAIL=${ADMIN_EMAIL}`) or be loaded with `env_file`.

### Deploying with Dokploy (or similar)

1. Create a Compose app that builds from this repository (`build: https://github.com/<you>/<repo>.git#main`).
2. Add the variables from the table above in the platform's environment settings, and reference them in the compose `environment:` list.
3. **Save** the compose file, then **Deploy**. A plain restart keeps the old container configuration.
4. Point your domain at port `8000` of the `app` service.

To check what the container actually received:

```bash
docker exec <container> printenv | grep -E "ADMIN|SESSION"
```

---

## 🧱 Tech stack
- Node.js 20, TypeScript
- Express, express-session
- [teleproto](https://www.npmjs.com/package/teleproto) (maintained fork of GramJS) for the Telegram MTProto client
- Multer (uploads), bcryptjs (password hashing)
- EJS-rendered admin templates, Tailwind via CDN, vanilla JS
- Docker (multi-stage build)

---

## ⚠️ Limitations

- **Everything is in memory.** File records (names, expiry, download counts) and admin sessions are lost on restart. Uploaded files stay in `uploads/` on disk, but their links stop working and nothing re-registers them. Run a **single instance** only.
- **Sample records.** On every start, three sample entries are added to the dashboard (two small files are written to `uploads/`).
- **Uploads are public.** `/` and `POST /api/upload` have no authentication. Anyone who can reach the site can upload. Restrict access at your reverse proxy if that is not what you want.
- **Local disk storage only.** There is no S3 or object-storage backend.
- **Public bot by default.** If `ALLOWED_USER_IDS` is empty, anyone who finds the bot can upload files to your server. Set it to your own Telegram user ID(s).
- **Bot needs outbound access to Telegram.** The server must be able to reach Telegram's servers on port 443.

---

## 📜 License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

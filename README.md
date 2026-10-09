![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)
![Node](https://img.shields.io/badge/node-20-green)
![TypeScript](https://img.shields.io/badge/TypeScript-5-blue)
![Framework](https://img.shields.io/badge/Express-4-lightgrey)
![Docker](https://img.shields.io/badge/docker-supported-blue)

# 📎 File Link Gateway

A small, self-hosted **file-to-direct-link service**. Upload a file from the web page and get back a **public download link** with optional **time-based expiry**, **per-IP rate limiting**, and an **admin dashboard** to manage every link.

It is a Node.js / TypeScript (Express) app that runs as a single container, with no database or cache to set up.

> **Origin:** forked from the original *Telegram File Link Bot* by Aman (Apache 2.0). The original was a Python / FastAPI Telegram bot backed by PostgreSQL, Redis and S3. **This fork has been rewritten** as a Node.js web app and **does not include the Telegram bot, PostgreSQL, Redis or S3 storage.** See [NOTICE](NOTICE) and [LICENSE](LICENSE).

---

## ✨ Features

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
| `ADMIN_ENABLED` | `true` | Turn the admin dashboard on or off |
| `ADMIN_EMAIL` | *(none)* | Admin login email |
| `ADMIN_PASSWORD` | *(none)* | Admin login password |
| `SESSION_SECRET` | random per start | Secret used to sign session cookies |
| `MAX_FILE_MB` | `500` | Maximum upload size in MB |
| `GLOBAL_RATE_LIMIT_REQUESTS` | `60` | Requests allowed per window per IP (`0` disables the limit) |
| `GLOBAL_RATE_LIMIT_WINDOW` | `10` | Rate-limit window in seconds |

---

## ▶️ Running locally

Requires Node.js 20+.

```bash
npm install
cp .env.example .env     # then set ADMIN_EMAIL, ADMIN_PASSWORD, SESSION_SECRET
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
docker run -d --env-file .env -p 8000:8000 -v uploads_data:/app/uploads file-link-gateway
```

### Docker Compose

The included `docker-compose.yml` builds the image and exposes port `8000` to a reverse proxy. Uploaded files are stored in the `uploads_data` volume.

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
- Multer (uploads), bcryptjs (password hashing)
- EJS-rendered admin templates, Tailwind via CDN, vanilla JS
- Docker (multi-stage build)

---

## ⚠️ Limitations

- **Everything is in memory.** File records (names, expiry, download counts) and admin sessions are lost on restart. Uploaded files stay in `uploads/` on disk, but their links stop working and nothing re-registers them. Run a **single instance** only.
- **Sample records.** On every start, three sample entries are added to the dashboard (two small files are written to `uploads/`).
- **Uploads are public.** `/` and `POST /api/upload` have no authentication. Anyone who can reach the site can upload. Restrict access at your reverse proxy if that is not what you want.
- **Local disk storage only.** There is no S3 or object-storage backend.
- **No Telegram bot** in this codebase.

---

## 📜 License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

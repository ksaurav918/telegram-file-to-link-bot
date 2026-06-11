# Telegram File Link Bot — PRD

## Problem statement
"Check the issues in this bot and fix them."

User's specific pain point:
> When I freeze a file from the dashboard it becomes volatile, but a refresh later the file disappears entirely. I want to keep manipulating the file (delete / rescue / set an expiry) on the dashboard after the upload link has been generated.

Plus: do a general code audit.

## Architecture
- **Bot**: Pyrofork (Pyrogram) — handles uploads & TTL mode commands.
- **API**: FastAPI — serves `/file/{id}` downloads + `/api/progress` polling.
- **Admin dashboard**: Jinja2-rendered, sessions via `SessionMiddleware`, argon2 password hashing.
- **DB**: PostgreSQL (`asyncpg`).
- **Cache**: Redis (`redis-py`, `decode_responses=True`).
- **Storage**: pluggable `local` filesystem (`/uploads`) or S3 (`boto3`).
- **Cleanup**: background task in `app/state.py` deletes physical file + Redis cache + DB row when `expires_at < NOW()`.

## What was implemented in this session

### Root-cause fix (Freeze losing files)
Previously **Freeze** set `expires_at = NOW()`. The 30s cleanup task immediately purged the file from disk + DB, so refreshing the dashboard showed it gone.

Fix:
1. Added an idempotent `ALTER TABLE files ADD COLUMN IF NOT EXISTS disabled BOOLEAN NOT NULL DEFAULT FALSE` migration in `db/database.py`.
2. **Freeze** (`POST /admin/file/{id}/disable`) now sets `disabled=TRUE` only — file & DB row are preserved indefinitely.
3. **Rescue** (`POST /admin/file/{id}/enable`) clears both `disabled` and `expires_at` → Persistent again.
4. **Set TTL** (`POST /admin/file/{id}/expiry`, new endpoint) accepts `30` / `2h` / `1d` / `0` and sets/clears `expires_at`.
5. **Purge** (`POST /admin/file/{id}/delete`) now uses a backend-aware `_remove_physical_file` helper that handles both local FS and S3 (previous code called `os.remove()` even for S3 keys).
6. Download endpoint `GET /file/{id}` now returns **403** if `disabled=TRUE`. Freeze/rescue/expiry handlers invalidate the Redis `file:{id}` cache so the new state takes effect immediately.

### Dashboard UI updates (`admin/templates/dashboard.html`)
- New **Frozen** badge (sky-blue) in addition to Volatile/Persistent.
- New **Rescue** button (only shown when file is Frozen or has an expiry).
- New inline **Set TTL** form per row (`30`, `2h`, `1d`, `0`).
- **Freeze** hidden once a file is already frozen.
- `data-testid` attributes added to all per-row interactive elements.

### Code-audit fixes
- `dashboard` files query: ordered by `created_at DESC` (was `downloads DESC LIMIT 50` — new uploads with 0 hits could be hidden forever). Bumped to 100.
- `active_files` stat now also excludes `disabled` files.
- `top_files` excludes disabled files.
- `expiring_files` query: only includes future expirations, ordered ASC (was DESC including already-expired rows).
- S3 path safety in `delete_file`.

## Backlog / future improvements (P2)
- `/admin/settings/save` is still a no-op stub — wire it to `set_setting()` for cleanup toggle & default TTL.
- Add CSRF protection on admin POST forms.
- Move `/api/progress` from `KEYS task_progress_*` to `SCAN` for very large Redis instances.
- Pagination on dashboard files table beyond 100 rows.
- Bulk freeze/purge actions.

## Files changed
- `db/database.py` — added `disabled` column migration.
- `admin/routes.py` — rewrote freeze/rescue, added `/expiry` endpoint, S3-safe delete, fixed dashboard queries.
- `admin/templates/dashboard.html` — Frozen badge, Rescue button, Set TTL form, test ids.
- `api/routes.py` — 403 when file is disabled, cache the disabled flag.

## Testing notes
Runtime testing was **NOT** performed in this environment because the user's `API_ID` / `API_HASH` / `BOT_TOKEN` / `DATABASE_URL` / `REDIS_URL` live only on their server. All changes are verified by static analysis (`ast.parse`, lint) and by tracing the freeze → cleanup interaction.

After deployment, the user should verify:
1. Upload a file via Telegram → link works.
2. From dashboard, click **Freeze** on the row → badge becomes "Frozen", file row still present after refresh, download URL returns 403.
3. Click **Rescue** → badge returns to "Persistent", download URL works again.
4. Type `2h` in TTL input and click **Set TTL** → badge becomes "Volatile", row still listed; after 2 hours the cleanup task removes it.
5. Click **Purge** → file gone permanently.

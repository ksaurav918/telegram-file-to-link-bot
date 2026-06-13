# Copyright 2025 Aman
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.

import os
import re
from datetime import datetime, timedelta, timezone

import boto3
from fastapi import APIRouter, Request, Depends, Form
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates
from passlib.hash import argon2

from db.database import Database
from cache.redis import redis_client
from admin.settings_store import get_setting
from admin.auth import admin_required
from config import (
    STORAGE_BACKEND,
    AWS_ENDPOINT_URL,
    AWS_S3_BUCKET_NAME,
    AWS_DEFAULT_REGION,
)

router = APIRouter(prefix="/admin", tags=["admin"])
templates = Jinja2Templates(directory="admin/templates")

# S3 client for delete operations on S3-backed installs
_s3 = None
if STORAGE_BACKEND == "s3":
    _s3 = boto3.client(
        "s3",
        endpoint_url=AWS_ENDPOINT_URL,
        region_name=AWS_DEFAULT_REGION,
    )


def _remove_physical_file(path: str | None) -> None:
    """Delete the underlying object regardless of storage backend. Never raises."""
    if not path:
        return
    try:
        if STORAGE_BACKEND == "local":
            if os.path.exists(path):
                os.remove(path)
        elif _s3 is not None:
            _s3.delete_object(Bucket=AWS_S3_BUCKET_NAME, Key=path)
    except Exception as e:
        print(f"⚠️ Failed to remove physical file {path}: {e}")


def _parse_ttl(value: str) -> int | None:
    """
    Parse TTL like '30' (minutes), '2h', '1d'. Returns seconds, or None if invalid.
    '0' or empty -> None means caller should treat as "no expiration".
    """
    if not value:
        return None
    m = re.match(r"^\s*(\d+)\s*([mhd]?)\s*$", value.lower())
    if not m:
        return None
    amount, unit = m.groups()
    amount = int(amount)
    if amount == 0:
        return 0
    if unit == "h":
        return amount * 3600
    if unit == "d":
        return amount * 86400
    return amount * 60


@router.get("")
async def admin_root():
    return RedirectResponse("/admin/", status_code=302)


@router.get("/login", response_class=HTMLResponse)
async def login_page(request: Request):
    return templates.TemplateResponse("login.html", {"request": request})


@router.post("/login")
async def login(
    request: Request,
    email: str = Form(...),
    password: str = Form(...),
):
    admin = await Database.pool.fetchrow(
        "SELECT id, password_hash FROM admins WHERE email=$1",
        email,
    )

    if not admin or not argon2.verify(password, admin["password_hash"]):
        return templates.TemplateResponse(
            "login.html",
            {"request": request, "error": "Invalid credentials"},
            status_code=401,
        )

    request.session["admin_id"] = admin["id"]
    return RedirectResponse("/admin/", status_code=303)


@router.get("/settings", response_class=HTMLResponse)
async def settings_page(
    request: Request,
    auth=Depends(admin_required),
):
    if isinstance(auth, RedirectResponse):
        return auth

    stats = await Database.pool.fetchrow("""
        SELECT
          COALESCE(SUM(file_size), 0) AS used_bytes,
          COUNT(*) AS total_files,
          COALESCE(MAX(file_size), 0) AS largest_file
        FROM files
    """)

    cleanup = await get_setting("cleanup_enabled", "true")

    return templates.TemplateResponse(
        "settings.html",
        {
            "request": request,
            "used_bytes": stats["used_bytes"],
            "total_files": stats["total_files"],
            "largest_file": stats["largest_file"],
            "cleanup_enabled": cleanup == "true",
        },
    )


@router.post("/settings/save")
async def save_settings(
    request: Request,
    auth=Depends(admin_required),
):
    if isinstance(auth, RedirectResponse):
        return auth

    return RedirectResponse("/admin/settings", status_code=303)


@router.post("/logout")
async def logout(request: Request):
    request.session.clear()
    return RedirectResponse("/admin/login", status_code=303)


@router.get("/", response_class=HTMLResponse)
async def dashboard(
    request: Request,
    q: str | None = None,
    auth=Depends(admin_required),
):
    if isinstance(auth, RedirectResponse):
        return auth

    stats = await Database.pool.fetchrow("""
        SELECT
          COUNT(*) AS total_files,
          COALESCE(SUM(downloads), 0) AS total_downloads,
          COUNT(*) FILTER (
            WHERE NOT disabled
              AND (expires_at IS NULL OR expires_at > NOW())
          ) AS active_files
        FROM files
    """)

    # Order by created_at so newly uploaded files always appear, regardless of hits
    rows = await Database.pool.fetch("""
        SELECT file_id, name, path, file_size, downloads, expires_at, disabled, created_at
        FROM files
        WHERE name ILIKE $1
        ORDER BY created_at DESC
        LIMIT 100
    """, f"%{q or ''}%")

    # Detect orphaned rows (physical file gone from disk).
    # Only meaningful for the local backend; for S3 we trust the bucket.
    files = []
    for r in rows:
        item = dict(r)
        if STORAGE_BACKEND == "local":
            item["missing"] = not (r["path"] and os.path.exists(r["path"]))
        else:
            item["missing"] = False
        files.append(item)

    top_files = await Database.pool.fetch("""
        SELECT name, downloads
        FROM files
        WHERE NOT disabled
        ORDER BY downloads DESC
        LIMIT 5
    """)

    recent_files = await Database.pool.fetch("""
        SELECT name, created_at
        FROM files
        ORDER BY created_at DESC
        LIMIT 5
    """)

    # Only show files that will actually expire in the future, soonest first
    expiring_files = await Database.pool.fetch("""
        SELECT name, expires_at
        FROM files
        WHERE expires_at IS NOT NULL
          AND expires_at > NOW()
        ORDER BY expires_at ASC
        LIMIT 5
    """)

    return templates.TemplateResponse(
        "dashboard.html",
        {
            "request": request,
            "stats": stats,
            "files": files,
            "top_files": top_files,
            "recent_files": recent_files,
            "expiring_files": expiring_files,
            "query": q or "",
        },
    )


@router.post("/file/{file_id}/delete")
async def delete_file(file_id: str, auth=Depends(admin_required)):
    if isinstance(auth, RedirectResponse):
        return auth

    row = await Database.pool.fetchrow(
        "SELECT path FROM files WHERE file_id=$1",
        file_id,
    )

    if row:
        _remove_physical_file(row["path"])

    await Database.pool.execute(
        "DELETE FROM files WHERE file_id=$1",
        file_id,
    )
    redis_client.delete(f"file:{file_id}")

    return RedirectResponse("/admin/", status_code=303)


@router.post("/file/{file_id}/disable")
async def disable_file(file_id: str, auth=Depends(admin_required)):
    """
    Freeze: block downloads but KEEP the file and DB row intact.
    Does NOT set expires_at (so the cleanup job will not delete it).
    """
    if isinstance(auth, RedirectResponse):
        return auth

    await Database.pool.execute(
        "UPDATE files SET disabled = TRUE WHERE file_id=$1",
        file_id,
    )
    redis_client.delete(f"file:{file_id}")

    return RedirectResponse("/admin/", status_code=303)


@router.post("/file/{file_id}/enable")
async def enable_file(file_id: str, auth=Depends(admin_required)):
    """
    Rescue: re-enable downloads AND clear any expiry so the file is persistent.
    """
    if isinstance(auth, RedirectResponse):
        return auth

    await Database.pool.execute(
        """
        UPDATE files
        SET disabled = FALSE,
            expires_at = NULL
        WHERE file_id=$1
        """,
        file_id,
    )
    redis_client.delete(f"file:{file_id}")

    return RedirectResponse("/admin/", status_code=303)


@router.post("/file/{file_id}/expiry")
async def set_file_expiry(
    file_id: str,
    ttl: str = Form(...),
    auth=Depends(admin_required),
):
    """
    Set/clear a TTL on a file from the dashboard.
    `ttl` accepts '30' (minutes), '2h', '1d', or '0'/empty to clear.
    """
    if isinstance(auth, RedirectResponse):
        return auth

    seconds = _parse_ttl(ttl)

    if seconds is None:
        # Invalid format -> bounce back without changing anything
        return RedirectResponse("/admin/", status_code=303)

    if seconds == 0:
        await Database.pool.execute(
            "UPDATE files SET expires_at = NULL WHERE file_id=$1",
            file_id,
        )
    else:
        expires_at = datetime.now(timezone.utc) + timedelta(seconds=seconds)
        await Database.pool.execute(
            "UPDATE files SET expires_at = $2 WHERE file_id=$1",
            file_id,
            expires_at,
        )

    redis_client.delete(f"file:{file_id}")

    return RedirectResponse("/admin/", status_code=303)

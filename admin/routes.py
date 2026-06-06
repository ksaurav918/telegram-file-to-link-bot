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
from fastapi import APIRouter, Request, Depends, Form
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates
from passlib.hash import argon2

from db.database import Database
from admin.settings_store import get_setting
from admin.auth import admin_required

router = APIRouter(prefix="/admin", tags=["admin"])
templates = Jinja2Templates(directory="admin/templates")

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
            WHERE expires_at IS NULL OR expires_at > NOW()
          ) AS active_files
        FROM files
    """)

    # FIXED: Added file_size to the SELECT array so the frontend can calculate MBs
    files = await Database.pool.fetch("""
        SELECT file_id, name, file_size, downloads, expires_at
        FROM files
        WHERE name ILIKE $1
        ORDER BY downloads DESC
        LIMIT 50
    """, f"%{q or ''}%")

    top_files = await Database.pool.fetch("""
        SELECT name, downloads
        FROM files
        ORDER BY downloads DESC
        LIMIT 5
    """)

    recent_files = await Database.pool.fetch("""
        SELECT name, created_at
        FROM files
        ORDER BY created_at DESC
        LIMIT 5
    """)

    # FIXED: Changed filters so that frozen/expired files still show up in this block
    expiring_files = await Database.pool.fetch("""
        SELECT name, expires_at
        FROM files
        WHERE expires_at IS NOT NULL
        ORDER BY expires_at DESC
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
        try:
            os.remove(row["path"])
        except Exception:
            pass

    await Database.pool.execute(
        "DELETE FROM files WHERE file_id=$1",
        file_id,
    )

    return RedirectResponse("/admin/", status_code=303)


@router.post("/file/{file_id}/disable")
async def disable_file(file_id: str, auth=Depends(admin_required)):
    if isinstance(auth, RedirectResponse):
        return auth

    # FIXED: Re-enabled standard timestamp allocation logic
    await Database.pool.execute(
        "UPDATE files SET expires_at = NOW() WHERE file_id=$1",
        file_id,
    )

    return RedirectResponse("/admin/", status_code=303)

# NEW ENDPOINT: Clean handling for the "Restore" button action
@router.post("/file/{file_id}/enable")
async def enable_file(file_id: str, auth=Depends(admin_required)):
    if isinstance(auth, RedirectResponse):
        return auth

    # Strips the expiration block completely, making it "Persistent" again
    await Database.pool.execute(
        "UPDATE files SET expires_at = NULL WHERE file_id=$1",
        file_id,
    )

    return RedirectResponse("/admin/", status_code=303)

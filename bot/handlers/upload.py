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

import asyncio
import uuid
import os
import shutil
import re
import time  # Added for progress throttling
import json  # Added to format Redis data
from datetime import datetime, timedelta, timezone

import boto3
from pyrogram import filters
from bot.bot import tg_client
from cache.redis import redis_client
from bot.utils.access import is_allowed
from bot.utils.mode import get_mode, format_ttl
from config import (
    BASE_URL,
    MAX_FILE_MB,
    MAX_CONCURRENT_TRANSFERS,
    STORAGE_BACKEND,
    AWS_ENDPOINT_URL,
    AWS_S3_BUCKET_NAME,
    AWS_DEFAULT_REGION,
)
from db.database import Database

UPLOAD_DIR = os.path.abspath("uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)

upload_semaphore = asyncio.Semaphore(MAX_CONCURRENT_TRANSFERS)

s3 = None
if STORAGE_BACKEND == "s3":
    s3 = boto3.client(
        "s3",
        endpoint_url=AWS_ENDPOINT_URL,
        region_name=AWS_DEFAULT_REGION,
    )

def safe_filename(name: str) -> str:
    return re.sub(r'[<>:"/\\|?*\x00-\x1F]', "_", name).strip()

@tg_client.on_message(
    filters.private & (
        filters.document
        | filters.video
        | filters.audio
        | filters.photo
        | filters.animation
        | filters.voice
        | filters.video_note
    )
)
async def upload_handler(_, message):
    if not message.from_user:
        return

    if not is_allowed(message.from_user.id):
        await message.reply("🚫 Unauthorized")
        return

    status = await message.reply("📥 Queued for processing…")

    async with upload_semaphore:
        await process_upload(message, status)


async def process_upload(message, status):
    media = (
        message.document
        or message.video
        or message.audio
        or message.photo
        or message.animation
        or message.voice
        or message.video_note
    )

    file_size = getattr(media, "file_size", None)

    if MAX_FILE_MB is not None and file_size:
        max_bytes = MAX_FILE_MB * 1024 * 1024
        if file_size > max_bytes:
            size_mb = file_size / (1024 * 1024)
            await status.edit(
                "❌ **File too large**\n\n"
                f"Your file: **{size_mb:.2f} MB**\n"
                f"Max allowed: **{MAX_FILE_MB} MB**"
            )
            return

    await status.edit("⬇️ Downloading…")
    
    # ---------------------------------------------------------
    # Generate ID early and track progress (Web + Telegram)
    # ---------------------------------------------------------
    file_id = uuid.uuid4().hex[:12]
    last_update_time = time.time()
    last_tg_percentage = 0  

    async def progress_tracker(current, total):
        nonlocal last_update_time, last_tg_percentage
        now = time.time()
        percentage = round((current / total) * 100, 2) if total else 0
        
        # 1. Update Redis for the Web Dashboard (Every 1 second)
        if now - last_update_time > 1.0 or current == total:
            progress_data = {
                "file_id": file_id,
                "progress": percentage,
                "status": "Downloading"
            }
            redis_client.setex(f"task_progress_{file_id}", 3600, json.dumps(progress_data))
            last_update_time = now

        # 2. Update Telegram Chat (Dynamic steps based on file size)
        if total:
            total_mb = total / (1024 * 1024)
            
            if total_mb >= 500:
                step = 10
            elif total_mb >= 100:
                step = 25
            elif total_mb >= 10:
                step = 50
            else:
                step = 200  # Keeps small files fast and quiet in chat

            if percentage - last_tg_percentage >= step and current != total:
                try:
                    # Create the visual text bar
                    filled = int(percentage / 10)
                    bar = "█" * filled + "░" * (10 - filled)
                    
                    current_mb = current / (1024 * 1024)
                    
                    await status.edit(
                        f"⬇️ **Downloading...**\n"
                        f"`[{bar}] {int(percentage)}%`\n"
                        f"📦 `{current_mb:.1f} MB / {total_mb:.1f} MB`"
                    )
                    last_tg_percentage = percentage
                except Exception:
                    pass

    # Pass the dynamic progress tracker into Pyrogram's download method
    temp_path = await message.download(progress=progress_tracker)
    # ---------------------------------------------------------

    if not temp_path:
        await status.edit("❌ Download failed")
        return

    if message.photo:
        original_name = f"{uuid.uuid4().hex}.jpg"
    elif hasattr(media, "file_name") and media.file_name:
        original_name = safe_filename(media.file_name)
    else:
        original_name = f"{uuid.uuid4().hex}.bin"

    file_size = file_size or os.path.getsize(temp_path)
    ext = os.path.splitext(original_name)[1]

    if STORAGE_BACKEND == "local":
        internal_path = os.path.join(UPLOAD_DIR, f"{file_id}{ext}")
        shutil.move(temp_path, internal_path) # Uses the shutil fix
        stored_path = internal_path
    else:
        key = f"{file_id}{ext}"
        s3.upload_file(temp_path, AWS_S3_BUCKET_NAME, key)
        os.remove(temp_path)
        stored_path = key

    user_mode = get_mode(message.from_user.id)

    if user_mode["ttl"] > 0:
        ttl = user_mode["ttl"]
        ttl_source = "👤 Using your TTL"
    else:
        ttl = 0
        ttl_source = "♾ No expiration"

    expires_at = (
        datetime.now(timezone.utc) + timedelta(seconds=ttl)
        if ttl > 0 else None
    )

    await Database.pool.execute(
        """
        INSERT INTO files (
            file_id, path, name, downloads, file_size, expires_at
        )
        VALUES ($1, $2, $3, 0, $4, $5)
        """,
        file_id,
        stored_path,
        original_name,
        file_size,
        expires_at,
    )

    redis_client.delete(f"file:{file_id}")
    redis_client.hset(
        f"file:{file_id}",
        mapping={
            "path": stored_path,
            "name": original_name,
            "downloads": 0,
            "file_size": file_size,
            "expires_at": int(expires_at.timestamp()) if expires_at else 0,
        }
    )

    # Mark task as 100% completed in Redis so the dashboard clears it
    redis_client.setex(
        f"task_progress_{file_id}", 
        3600, 
        json.dumps({"file_id": file_id, "progress": 100.0, "status": "Completed"})
    )

    size_mb = file_size / (1024 * 1024)

    await status.edit(
        "✅ **File uploaded**\n\n"
        f"{ttl_source}\n"
        f"📄 **Name:** `{original_name}`\n"
        f"📦 **Size:** `{size_mb:.2f} MB`\n"
        f"⏳ **Expires:** {format_ttl(ttl)}\n\n"
        f"🔗 `{BASE_URL}/file/{file_id}`"
    )

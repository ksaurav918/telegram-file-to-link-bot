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
import boto3
import json  # Added to decode the progress JSON data
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from cache.redis import redis_client
from db.database import Database
from config import (
    GLOBAL_RATE_LIMIT_REQUESTS,
    GLOBAL_RATE_LIMIT_WINDOW,
    STORAGE_BACKEND,
    AWS_ENDPOINT_URL,
    AWS_S3_BUCKET_NAME,
    AWS_DEFAULT_REGION,
)

router = APIRouter()

s3 = None
if STORAGE_BACKEND == "s3":
    s3 = boto3.client(
        "s3",
        endpoint_url=AWS_ENDPOINT_URL,
        region_name=AWS_DEFAULT_REGION,
    )

def get_real_ip(request: Request) -> str:
    return (
        request.headers.get("cf-connecting-ip")
        or request.headers.get("x-forwarded-for", "").split(",")[0]
        or request.client.host
    )


def rate_limit_response(window: int):
    return JSONResponse(
        status_code=429,
        content={"error": "rate_limited", "retry_after": window},
        headers={"Retry-After": str(window)},
    )


def check_rate_limit(key: str, limit: int, window: int):
    count = redis_client.incr(key)
    if count == 1:
        redis_client.expire(key, window)
    if count > limit:
        return rate_limit_response(window)


# ---------------------------------------------------------
# NEW CODE: Endpoint to return active transfer progress
# ---------------------------------------------------------
@router.get("/api/progress")
async def get_active_progress():
    active_tasks = []
    # Find all keys matching the task pattern
    keys = redis_client.keys("task_progress_*")
    
    for key in keys:
        value = redis_client.get(key)
        if value:
            try:
                task_data = json.loads(value)
                active_tasks.append(task_data)
                
                # Automatically clear completed items from list after reading them once
                if task_data.get("status") == "Completed":
                    redis_client.delete(key)
            except Exception:
                continue
                
    return {"tasks": active_tasks}
# ---------------------------------------------------------


@router.get("/file/{file_id}")
async def get_file(file_id: str, request: Request):

    ip = get_real_ip(request)

    if GLOBAL_RATE_LIMIT_REQUESTS > 0:
        if resp := check_rate_limit(
            f"rate:global:{ip}",
            GLOBAL_RATE_LIMIT_REQUESTS,
            GLOBAL_RATE_LIMIT_WINDOW,
        ):
            return resp

    key = f"file:{file_id}"
    meta = redis_client.hgetall(key)

    if not meta:
        row = await Database.pool.fetchrow(
            "SELECT path, name, downloads, disabled FROM files WHERE file_id=$1",
            file_id,
        )
        if not row:
            raise HTTPException(404, "File not found")

        meta = dict(row)
        # asyncpg returns Python bool for the `disabled` column; normalize for Redis
        meta["disabled"] = "1" if meta.get("disabled") else "0"
        redis_client.hset(key, mapping=meta)

    if str(meta.get("disabled", "0")) in ("1", "True", "true"):
        raise HTTPException(403, "File is frozen by the administrator")

    download_key = f"downloaded:{ip}:{file_id}"
    if not redis_client.exists(download_key):
        redis_client.setex(download_key, 3600, 1)

        await Database.pool.execute(
            "UPDATE files SET downloads = downloads + 1 WHERE file_id=$1",
            file_id,
        )

        redis_client.hincrby(key, "downloads", 1)

    if STORAGE_BACKEND == "local":
        if not os.path.exists(meta["path"]):
            raise HTTPException(404, "File missing")

        return FileResponse(
            path=meta["path"],
            filename=meta["name"],
            media_type="application/octet-stream",
        )

    url = s3.generate_presigned_url(
        "get_object",
        Params={
            "Bucket": AWS_S3_BUCKET_NAME,
            "Key": meta["path"],
        },
        ExpiresIn=3600, 
    )

    return RedirectResponse(url, status_code=302)

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
import asyncio
import boto3
from db.database import Database
from cache.redis import redis_client
from config import (
    STORAGE_BACKEND,
    AWS_ENDPOINT_URL,
    AWS_S3_BUCKET_NAME,
    AWS_DEFAULT_REGION,
)

CLEANUP_INTERVAL = 30 

s3 = None
if STORAGE_BACKEND == "s3":
    s3 = boto3.client(
        "s3",
        endpoint_url=AWS_ENDPOINT_URL,
        region_name=AWS_DEFAULT_REGION,
    )


async def cleanup_expired_files():
    while True:
        try:
            async with Database.pool.acquire() as conn:
                # Atomic: take ownership of the rows we are about to clean up.
                # Returning the rows first guarantees that we only remove the
                # underlying file/cache for rows we actually deleted, with no
                # race window against /enable, /disable or /expiry updates.
                rows = await conn.fetch(
                    """
                    DELETE FROM files
                    WHERE expires_at IS NOT NULL
                      AND expires_at < (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
                    RETURNING file_id, path
                    """
                )

                for row in rows:
                    file_id = row["file_id"]
                    path = row["path"]

                    try:
                        if STORAGE_BACKEND == "local":
                            # Local filesystem cleanup
                            if path and os.path.exists(path):
                                os.remove(path)
                        else:
                            # S3 bucket cleanup
                            s3.delete_object(
                                Bucket=AWS_S3_BUCKET_NAME,
                                Key=path,
                            )
                    except Exception as e:
                        # Never crash cleanup loop
                        print(f"⚠️ Failed to delete file {file_id}: {e}")

                    # Clear Redis cache
                    redis_client.delete(f"file:{file_id}")

        except Exception as e:
            print("❌ Cleanup error:", e)

        await asyncio.sleep(CLEANUP_INTERVAL)

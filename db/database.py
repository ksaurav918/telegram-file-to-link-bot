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

import asyncpg
from config import DATABASE_URL

if not DATABASE_URL:
    raise RuntimeError("❌ DATABASE_URL is required but not set")


CREATE_FILES_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS files (
    file_id TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    name TEXT NOT NULL,
    downloads INTEGER NOT NULL DEFAULT 0,
    file_size BIGINT,
    expires_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_files_expires
ON files (expires_at);

-- Idempotent migration: add `disabled` flag for dashboard freeze/rescue
ALTER TABLE files
ADD COLUMN IF NOT EXISTS disabled BOOLEAN NOT NULL DEFAULT FALSE;
"""

CREATE_ADMINS_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS admins (
    id SERIAL PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
"""
CREATE_SETTINGS_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""

INSERT_DEFAULT_SETTINGS_SQL = """
INSERT INTO settings (key, value) VALUES
  ('default_max_downloads', '0'),
  ('cleanup_enabled', 'true')
ON CONFLICT (key) DO NOTHING;
"""

class Database:
    pool: asyncpg.Pool | None = None

    @classmethod
    async def connect(cls):
        cls.pool = await asyncpg.create_pool(
            DATABASE_URL,
            min_size=1,
            max_size=10,
            command_timeout=60,
            server_settings={"timezone": "UTC"},
        )
        await cls._init_schema()
        print("✅ PostgreSQL connected & schema ensured")

    @classmethod
    async def _init_schema(cls):
        async with cls.pool.acquire() as conn:
            await conn.execute(CREATE_FILES_TABLE_SQL)
            await conn.execute(CREATE_ADMINS_TABLE_SQL)
            await conn.execute(CREATE_SETTINGS_TABLE_SQL)
            await conn.execute(INSERT_DEFAULT_SETTINGS_SQL)

    @classmethod
    async def close(cls):
        if cls.pool:
            await cls.pool.close()
            print("🛑 PostgreSQL connection closed")

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { TelegramClient, Api, Logger, sessions, events } from 'teleproto';

/**
 * Telegram bot (MTProto, so files up to 2 GB can be downloaded).
 *
 * Send the bot a file, it stores it in the uploads folder, registers it in the
 * same store as the web uploads and replies with a direct download link.
 * Commands: /start, /mode (per-user default expiry).
 */

export interface BotContext {
  uploadDir: string;
  maxFileMb: number;
  /** Public base URL used to build download links, without trailing slash. */
  baseUrl: string;
  /** "30" | "2h" | "1d" | "0" -> seconds (0 = never), null when invalid. */
  parseTTL: (value: string) => number | null;
  registerFile: (file: {
    file_id: string;
    path: string;
    name: string;
    file_size: number;
    expires_at: Date | null;
  }) => void;
  setProgress: (fileId: string, progress: number, status: string) => void;
  clearProgress: (fileId: string) => void;
}

const MAX_TTL_SECONDS = 30 * 86400;

// ---------------------------------------------------------------- helpers

function parseAllowedIds(raw: string | undefined): Set<number> | null {
  if (!raw || !raw.trim()) return null;
  const ids = raw
    .split(',')
    .map(s => parseInt(s.trim(), 10))
    .filter(n => Number.isFinite(n));
  return ids.length ? new Set(ids) : null;
}

function formatTTL(seconds: number): string {
  if (seconds === 0) return 'Never';
  if (seconds < 60) return `${seconds} seconds`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} minutes`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hours`;
  return `${Math.floor(seconds / 86400)} days`;
}

function safeFilename(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[<>:"/\\|?*`\x00-\x1F]/g, '_').trim();
}

const MIME_EXT: Record<string, string> = {
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
  'video/x-matroska': '.mkv',
  'audio/mpeg': '.mp3',
  'audio/ogg': '.ogg',
  'audio/mp4': '.m4a',
  'audio/x-m4a': '.m4a',
  'audio/wav': '.wav',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
  'application/zip': '.zip',
};

const toNumber = (v: unknown): number => Number(String(v));

/** Runs at most `limit` jobs at once, the rest wait in a queue. */
class Semaphore {
  private active = 0;
  private waiting: Array<() => void> = [];
  constructor(private readonly limit: number) {}

  async run<T>(job: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>(resolve => this.waiting.push(resolve));
    }
    this.active++;
    try {
      return await job();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

/** Per-user default TTL, persisted as JSON so it survives restarts. */
class ModeStore {
  private data: Record<string, number> = {};
  constructor(private readonly file: string) {
    try {
      this.data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      this.data = {};
    }
  }
  get(userId: number): number {
    return this.data[String(userId)] || 0;
  }
  set(userId: number, ttl: number) {
    if (ttl > 0) this.data[String(userId)] = ttl;
    else delete this.data[String(userId)];
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.data));
    } catch (err) {
      console.error('[Bot] could not save modes:', err);
    }
  }
}

// ------------------------------------------------------------------- bot

export async function startBot(ctx: BotContext): Promise<void> {
  const apiId = parseInt(process.env.API_ID || '', 10);
  const apiHash = (process.env.API_HASH || '').trim();
  const botToken = (process.env.BOT_TOKEN || '').trim();

  if (!Number.isFinite(apiId) || !apiHash || !botToken) {
    console.log('[Bot] Telegram bot disabled (set API_ID, API_HASH and BOT_TOKEN to enable it).');
    return;
  }

  const allowed = parseAllowedIds(process.env.ALLOWED_USER_IDS);
  if (!allowed) {
    console.warn('[Bot] ALLOWED_USER_IDS is not set: ANYONE who finds the bot can upload files.');
  }

  const maxConcurrent = Math.max(1, parseInt(process.env.MAX_CONCURRENT_TRANSFERS || '3', 10) || 3);
  const semaphore = new Semaphore(maxConcurrent);

  const sessionDir = path.resolve(process.env.SESSION_DIR || 'session');
  fs.mkdirSync(sessionDir, { recursive: true });
  const sessionFile = path.join(sessionDir, 'bot.session');
  const modes = new ModeStore(path.join(sessionDir, 'modes.json'));

  // Reuse the saved login, unless the bot token changed since it was saved.
  const tokenHash = crypto.createHash('sha256').update(botToken).digest('hex').slice(0, 16);
  let savedSession = '';
  try {
    const raw = fs.readFileSync(sessionFile, 'utf8').trim();
    if (raw.startsWith(`${tokenHash}:`)) savedSession = raw.slice(tokenHash.length + 1);
  } catch {
    /* no saved session yet */
  }

  const client = new TelegramClient(new sessions.StringSession(savedSession), apiId, apiHash, {
    connectionRetries: 5,
    baseLogger: new Logger('error' as any),
  });
  client.setParseMode('md');

  await client.start({ botAuthToken: botToken });

  try {
    const session = (client.session as sessions.StringSession).save();
    fs.writeFileSync(sessionFile, `${tokenHash}:${session}`, { mode: 0o600 });
  } catch (err) {
    console.error('[Bot] could not save session:', err);
  }

  const isAllowed = (userId: number) => !allowed || allowed.has(userId);

  // ----- /mode ---------------------------------------------------------
  async function handleMode(message: Api.Message, userId: number, args: string[]) {
    if (args.length === 0) {
      const ttl = modes.get(userId);
      await message.reply({
        message:
          '📌 **Mode (TTL)**\n\n' +
          `Effective TTL: **${formatTTL(ttl)}**\n` +
          `${ttl > 0 ? '👤 Your TTL' : '♾ No expiration'}\n\n` +
          'Set expiration for your uploads:\n' +
          '`/mode ttl 30` → 30 minutes\n' +
          '`/mode ttl 2h` → 2 hours\n' +
          '`/mode ttl 1d` → 1 day\n' +
          '`/mode ttl 0` → Never expire\n\n' +
          '`/mode reset`',
      });
      return;
    }

    const sub = args[0].toLowerCase();

    if (sub === 'ttl') {
      if (args.length !== 2) {
        await message.reply({ message: '❌ Usage: `/mode ttl <minutes|h|d>`' });
        return;
      }
      const ttl = ctx.parseTTL(args[1]);
      if (ttl === null) {
        await message.reply({
          message:
            '❌ Invalid TTL format\n\nExamples:\n`/mode ttl 30`\n`/mode ttl 2h`\n`/mode ttl 1d`\n`/mode ttl 0`',
        });
        return;
      }
      if (ttl > MAX_TTL_SECONDS) {
        await message.reply({ message: '❌ Max TTL is 30 days' });
        return;
      }
      modes.set(userId, ttl);
      await message.reply({
        message: ttl === 0 ? '⏳ TTL disabled' : `⏳ TTL set to **${formatTTL(ttl)}**`,
      });
      return;
    }

    if (sub === 'reset') {
      modes.set(userId, 0);
      await message.reply({ message: '♻️ Mode reset (Never expire)' });
      return;
    }

    await message.reply({ message: '❌ Unknown command' });
  }

  // ----- file upload ---------------------------------------------------
  async function handleUpload(message: Api.Message, userId: number) {
    const status = await message.reply({ message: '📥 Queued for processing…' });
    if (!status) return;

    const edit = async (text: string) => {
      try {
        await status.edit({ text });
      } catch {
        /* message unchanged / flood wait: not worth failing the upload */
      }
    };

    await semaphore.run(async () => {
      const fileId = crypto.randomBytes(6).toString('hex');
      let finalPath = '';
      try {
        const info = message.file;
        const mime: string | undefined = info?.mimeType;
        const declaredSize = info?.size !== undefined ? toNumber(info.size) : 0;

        if (ctx.maxFileMb > 0 && declaredSize > ctx.maxFileMb * 1024 * 1024) {
          await edit(
            '❌ **File too large**\n\n' +
              `Your file: **${(declaredSize / 1048576).toFixed(2)} MB**\n` +
              `Max allowed: **${ctx.maxFileMb} MB**`
          );
          return;
        }

        // Work out a display name and the extension to store it under.
        let name: string;
        if (message.photo) {
          name = `${crypto.randomBytes(8).toString('hex')}.jpg`;
        } else if (info?.name) {
          name = safeFilename(String(info.name)) || `${crypto.randomBytes(8).toString('hex')}.bin`;
        } else {
          name = `${crypto.randomBytes(8).toString('hex')}${(mime && MIME_EXT[mime]) || '.bin'}`;
        }
        const ext = path.extname(name);
        finalPath = path.join(ctx.uploadDir, `${fileId}${ext}`);

        await edit('⬇️ Downloading…');
        ctx.setProgress(fileId, 0, 'Downloading');

        let lastTaskUpdate = 0;
        let lastEditAt = 0;
        let lastEditPct = 0;

        await client.downloadMedia(message, {
          outputFile: finalPath,
          progressCallback: ((downloaded: unknown, total: unknown) => {
            const cur = toNumber(downloaded);
            const tot = toNumber(total) || declaredSize;
            if (!tot) return;
            const pct = Math.min(100, Math.round((cur / tot) * 10000) / 100);
            const now = Date.now();

            if (now - lastTaskUpdate > 1000 || cur >= tot) {
              ctx.setProgress(fileId, pct, 'Downloading');
              lastTaskUpdate = now;
            }

            // Only touch the chat message a few times, bigger files get more updates.
            const totalMb = tot / 1048576;
            const step = totalMb >= 500 ? 10 : totalMb >= 100 ? 25 : totalMb >= 10 ? 50 : 200;
            if (pct - lastEditPct >= step && cur < tot && now - lastEditAt > 3000) {
              lastEditPct = pct;
              lastEditAt = now;
              const filled = Math.floor(pct / 10);
              const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
              void edit(
                '⬇️ **Downloading...**\n' +
                  `\`[${bar}] ${Math.floor(pct)}%\`\n` +
                  `📦 \`${(cur / 1048576).toFixed(1)} MB / ${totalMb.toFixed(1)} MB\``
              );
            }
          }) as any,
        });

        if (!fs.existsSync(finalPath)) {
          ctx.clearProgress(fileId);
          await edit('❌ Download failed');
          return;
        }

        const fileSize = fs.statSync(finalPath).size;

        // The size is not always known up front (photos), so check again.
        if (ctx.maxFileMb > 0 && fileSize > ctx.maxFileMb * 1024 * 1024) {
          fs.unlinkSync(finalPath);
          ctx.clearProgress(fileId);
          await edit(
            '❌ **File too large**\n\n' +
              `Your file: **${(fileSize / 1048576).toFixed(2)} MB**\n` +
              `Max allowed: **${ctx.maxFileMb} MB**`
          );
          return;
        }

        const ttl = modes.get(userId);
        const expiresAt = ttl > 0 ? new Date(Date.now() + ttl * 1000) : null;

        ctx.registerFile({
          file_id: fileId,
          path: finalPath,
          name,
          file_size: fileSize,
          expires_at: expiresAt,
        });
        ctx.setProgress(fileId, 100, 'Completed');

        await edit(
          '✅ **File uploaded**\n\n' +
            `${ttl > 0 ? '👤 Using your TTL' : '♾ No expiration'}\n` +
            `📄 **Name:** \`${name}\`\n` +
            `📦 **Size:** \`${(fileSize / 1048576).toFixed(2)} MB\`\n` +
            `⏳ **Expires:** ${formatTTL(ttl)}\n\n` +
            `🔗 \`${ctx.baseUrl}/file/${fileId}\``
        );
      } catch (err) {
        console.error('[Bot] upload failed:', err);
        ctx.clearProgress(fileId);
        if (finalPath) {
          try {
            fs.unlinkSync(finalPath);
          } catch {
            /* nothing to remove */
          }
        }
        await edit('❌ Upload failed. Please try again.');
      }
    });
  }

  // ----- dispatcher ----------------------------------------------------
  async function onMessage(event: events.NewMessageEvent) {
    try {
      const message = event.message;
      if (!event.isPrivate || message.out || message.senderId === undefined) return;

      const userId = toNumber(message.senderId);
      const text = (message.message || '').trim();
      const cmd = text.match(/^\/(\w+)(?:@\w+)?(?:\s+([\s\S]*))?$/);

      if (cmd) {
        const name = cmd[1].toLowerCase();
        if (name !== 'start' && name !== 'mode') return;
        if (!isAllowed(userId)) {
          await message.reply({ message: '🚫 This bot is private.' });
          return;
        }
        if (name === 'start') {
          await message.reply({
            message:
              '👋 Send me a file and I’ll generate a download link.\n' +
              '📎 Send images as **File** to keep original quality.',
          });
        } else {
          await handleMode(message, userId, (cmd[2] || '').split(/\s+/).filter(Boolean));
        }
        return;
      }

      // Plain documents, video, audio, voice, video notes, animations and photos.
      const isSticker = !!message.document?.attributes?.some(
        a => a instanceof Api.DocumentAttributeSticker
      );
      if ((message.photo || message.document) && !isSticker) {
        if (!isAllowed(userId)) {
          await message.reply({ message: '🚫 Unauthorized' });
          return;
        }
        await handleUpload(message, userId);
      }
    } catch (err) {
      console.error('[Bot] handler error:', err);
    }
  }

  client.addEventHandler(onMessage, new events.NewMessage({}));

  const me = (await client.getMe()) as Api.User;
  console.log(
    `🤖 Telegram bot started as @${me.username ?? me.id} ` +
      `(${allowed ? `${allowed.size} allowed user(s)` : 'open to everyone'}, ${maxConcurrent} concurrent transfers)`
  );
}

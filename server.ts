import express, { Request, Response, NextFunction } from 'express';
import session from 'express-session';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import dotenv from 'dotenv';
import { startBot } from './bot.js';

dotenv.config();

const PORT = parseInt(process.env.PORT || '3000', 10);
const ADMIN_ENABLED = (process.env.ADMIN_ENABLED || 'true').toLowerCase() === 'true';
// No fallback credentials: if these are missing, no admin account is created
// and every login attempt is rejected.
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').trim();
const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || '').trim();
// No hardcoded session secret: if unset, use a random one (sessions reset on restart).
const SESSION_SECRET = (process.env.SESSION_SECRET || '').trim() || crypto.randomBytes(32).toString('hex');
const MAX_FILE_MB = parseInt(process.env.MAX_FILE_MB || '500', 10);

// Public URL used in generated download links. Falls back to the request's own
// host when not set. Accepts "files.example.com" or "https://files.example.com/".
function normalizeBaseUrl(value: string | undefined): string {
  const v = (value || '').trim().replace(/\/+$/, '');
  if (!v) return '';
  return /^https?:\/\//i.test(v) ? v : `https://${v}`;
}
const BASE_URL = normalizeBaseUrl(process.env.BASE_URL);
const GLOBAL_RATE_LIMIT_REQUESTS = parseInt(process.env.GLOBAL_RATE_LIMIT_REQUESTS || '60', 10);
const GLOBAL_RATE_LIMIT_WINDOW = parseInt(process.env.GLOBAL_RATE_LIMIT_WINDOW || '10', 10);

const UPLOAD_DIR = path.resolve('uploads');
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// In-Memory Data Models
interface FileRecord {
  file_id: string;
  path: string;
  name: string;
  downloads: number;
  file_size: number;
  expires_at: Date | null;
  disabled: boolean;
  created_at: Date;
  missing?: boolean;
}

interface AdminUser {
  id: number;
  email: string;
  password_hash: string;
}

interface TaskProgress {
  file_id: string;
  progress: number;
  status: string;
}

// Global In-Memory Stores
const filesStore: Map<string, FileRecord> = new Map();
const adminsStore: AdminUser[] = [];
const downloadTracker: Map<string, number> = new Map(); // ip:file_id -> timestamp
const rateLimitTracker: Map<string, { count: number; resetAt: number }> = new Map();
const taskProgressStore: Map<string, TaskProgress> = new Map();

// Bootstrap Admin (only when both ADMIN_EMAIL and ADMIN_PASSWORD are set)
if (ADMIN_ENABLED) {
  if (ADMIN_EMAIL && ADMIN_PASSWORD) {
    adminsStore.push({
      id: 1,
      email: ADMIN_EMAIL,
      password_hash: bcrypt.hashSync(ADMIN_PASSWORD, 10),
    });
  } else {
    console.warn('[Admin] ADMIN_EMAIL and/or ADMIN_PASSWORD not set: no admin account exists, all logins will be rejected.');
  }
  if (!process.env.SESSION_SECRET || !process.env.SESSION_SECRET.trim()) {
    console.warn('[Admin] SESSION_SECRET not set: using a random one, sessions will reset on every restart.');
  }
}

// Seed Initial Files so dashboard has rich initial state
function seedDemoFiles() {
  const sample1Path = path.join(UPLOAD_DIR, 'a1b2c3d4e5f6.bin');
  const sample2Path = path.join(UPLOAD_DIR, 'f9e8d7c6b5a4.log');
  
  // Write mock file contents to disk
  fs.writeFileSync(sample1Path, Buffer.alloc(1024 * 512, 'X')); // 512KB
  fs.writeFileSync(sample2Path, 'SYSTEM LOG TELEMETRY DUMP\n' + 'Log line entry data\n'.repeat(100));

  filesStore.set('a1b2c3d4e5f6', {
    file_id: 'a1b2c3d4e5f6',
    path: sample1Path,
    name: 'dataset_archive_v2.tar.gz',
    downloads: 142,
    file_size: 104857600, // 100 MB
    expires_at: null,
    disabled: false,
    created_at: new Date(Date.now() - 3600000 * 24),
  });

  filesStore.set('f9e8d7c6b5a4', {
    file_id: 'f9e8d7c6b5a4',
    path: sample2Path,
    name: 'system_telemetry_dump.log',
    downloads: 48,
    file_size: 15728640, // 15 MB
    expires_at: new Date(Date.now() + 3600000 * 48),
    disabled: false,
    created_at: new Date(Date.now() - 3600000 * 5),
  });

  filesStore.set('e5d4c3b2a100', {
    file_id: 'e5d4c3b2a100',
    path: path.join(UPLOAD_DIR, 'missing_file.bin'),
    name: 'firmware_patch_v3.bin',
    downloads: 89,
    file_size: 52428800, // 50 MB
    expires_at: null,
    disabled: true,
    created_at: new Date(Date.now() - 3600000 * 12),
  });
}

seedDemoFiles();

// Periodical Cleanup Task for Expired Files (every 30 seconds)
setInterval(() => {
  const now = new Date();
  for (const [fileId, file] of filesStore.entries()) {
    if (file.expires_at && file.expires_at < now) {
      if (fs.existsSync(file.path)) {
        try { fs.unlinkSync(file.path); } catch (e) { /* ignore */ }
      }
      filesStore.delete(fileId);
      console.log(`[Cleanup] Expired file purged: ${fileId}`);
    }
  }
}, 30000);

// Express Application Setup
const app = express();

app.set('views', path.resolve('admin/templates'));
app.set('view engine', 'html');
app.engine('html', (filePath: string, options: any, callback: any) => {
  import('ejs').then(ejs => {
    ejs.renderFile(filePath, options, {}, callback);
  }).catch(err => callback(err));
});

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 3600 * 1000 }
}));

app.use('/static', express.static(path.resolve('static')));

// Helper functions
function getRealIp(req: Request): string {
  const cfIp = req.headers['cf-connecting-ip'];
  if (cfIp) return Array.isArray(cfIp) ? cfIp[0] : cfIp;
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    const ips = (Array.isArray(forwarded) ? forwarded[0] : forwarded).split(',');
    return ips[0].trim();
  }
  return req.socket.remoteAddress || '127.0.0.1';
}

function checkRateLimit(ip: string): boolean {
  if (GLOBAL_RATE_LIMIT_REQUESTS <= 0) return true;
  const now = Date.now();
  const record = rateLimitTracker.get(ip) || { count: 0, resetAt: now + GLOBAL_RATE_LIMIT_WINDOW * 1000 };
  
  if (now > record.resetAt) {
    record.count = 1;
    record.resetAt = now + GLOBAL_RATE_LIMIT_WINDOW * 1000;
  } else {
    record.count++;
  }
  
  rateLimitTracker.set(ip, record);
  return record.count <= GLOBAL_RATE_LIMIT_REQUESTS;
}

function parseTTL(value: string): number | null {
  if (!value) return null;
  const match = value.trim().toLowerCase().match(/^(\d+)\s*([mhd]?)$/);
  if (!match) return null;
  const amount = parseInt(match[1], 10);
  const unit = match[2];
  if (amount === 0) return 0;
  if (unit === 'h') return amount * 3600;
  if (unit === 'd') return amount * 86400;
  return amount * 60; // default minutes
}

// Configure Multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    const fileId = crypto.randomBytes(6).toString('hex');
    const ext = path.extname(file.originalname);
    (req as any).uploadedFileId = fileId;
    cb(null, `${fileId}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024 }
});

// Middleware for Admin Authorization
function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!(req.session as any).adminId) {
    return res.redirect('/admin/login');
  }
  next();
}

// Render error page helper
function renderError(res: Response, statusCode: number, context: { title: string; icon: string; message: string; hint?: string; back_url?: string }) {
  res.status(statusCode).render('error.html', context);
}

// -------------------------------------------------------------
// PUBLIC ROUTES
// -------------------------------------------------------------

// Home Landing & Direct Upload Hub
app.get('/', (req: Request, res: Response) => {
  res.render('index.html', {
    baseUrl: BASE_URL || `${req.protocol}://${req.get('host')}`,
    adminEnabled: ADMIN_ENABLED
  });
});

// Direct Download Link Route
app.get('/file/:file_id', (req: Request, res: Response) => {
  const ip = getRealIp(req);
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'rate_limited', retry_after: GLOBAL_RATE_LIMIT_WINDOW });
  }

  const fileId = req.params.file_id;
  const file = filesStore.get(fileId);

  if (!file) {
    return renderError(res, 404, {
      title: 'File Not Found',
      icon: '🔍',
      message: 'This download link is invalid or no longer available.',
      hint: 'The file may have expired or been deleted by the owner.',
      back_url: '/admin'
    });
  }

  if (file.disabled) {
    return renderError(res, 403, {
      title: 'Access Denied',
      icon: '⛔',
      message: 'You are not allowed to access this file.',
      hint: 'File is frozen by the administrator',
      back_url: '/admin'
    });
  }

  if (file.expires_at && file.expires_at < new Date()) {
    filesStore.delete(fileId);
    if (fs.existsSync(file.path)) {
      try { fs.unlinkSync(file.path); } catch (e) { /* ignore */ }
    }
    return renderError(res, 404, {
      title: 'File Not Found',
      icon: '🔍',
      message: 'This download link is invalid or no longer available.',
      hint: 'The file has expired.',
      back_url: '/admin'
    });
  }

  // Increment downloads if not already downloaded in last 1 hour by this IP
  const trackKey = `${ip}:${fileId}`;
  const lastDownload = downloadTracker.get(trackKey);
  if (!lastDownload || Date.now() - lastDownload > 3600000) {
    downloadTracker.set(trackKey, Date.now());
    file.downloads += 1;
  }

  if (!fs.existsSync(file.path)) {
    return renderError(res, 404, {
      title: 'File Missing',
      icon: '⚠️',
      message: 'The physical file is missing on server disk.',
      back_url: '/admin'
    });
  }

  res.download(file.path, file.name);
});

// Active Progress Tracking API
app.get('/api/progress', (req: Request, res: Response) => {
  const activeTasks: TaskProgress[] = [];
  for (const [key, task] of taskProgressStore.entries()) {
    activeTasks.push(task);
    if (task.status === 'Completed') {
      taskProgressStore.delete(key);
    }
  }
  res.json({ tasks: activeTasks });
});

// Web File Upload Endpoint
app.post('/api/upload', upload.single('file'), (req: Request, res: Response) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file provided' });
  }

  const fileId = (req as any).uploadedFileId || crypto.randomBytes(6).toString('hex');
  const storedPath = req.file.path;
  const originalName = req.file.originalname;
  const fileSize = req.file.size;

  const ttlSeconds = req.body.ttl ? parseTTL(req.body.ttl) : null;
  const expiresAt = ttlSeconds && ttlSeconds > 0 ? new Date(Date.now() + ttlSeconds * 1000) : null;

  filesStore.set(fileId, {
    file_id: fileId,
    path: storedPath,
    name: originalName,
    downloads: 0,
    file_size: fileSize,
    expires_at: expiresAt,
    disabled: false,
    created_at: new Date()
  });

  // Task progress update
  taskProgressStore.set(fileId, {
    file_id: fileId,
    progress: 100,
    status: 'Completed'
  });

  const baseUrl = BASE_URL || `${req.protocol}://${req.get('host')}`;
  res.json({
    success: true,
    file_id: fileId,
    name: originalName,
    size: fileSize,
    download_url: `${baseUrl}/file/${fileId}`
  });
});

// -------------------------------------------------------------
// ADMIN ROUTES
// -------------------------------------------------------------

if (ADMIN_ENABLED) {
  // NOTE: no separate '/admin' -> '/admin/' redirect here. Express routing is
  // non-strict, so that route also matched '/admin/' and caused an infinite
  // redirect loop right after login. The '/admin/' handler below serves both.

  app.get('/admin/login', (req: Request, res: Response) => {
    res.render('login.html', { error: null });
  });

  app.post('/admin/login', (req: Request, res: Response) => {
    const rawEmail = req.body.email ? String(req.body.email).trim().toLowerCase() : '';
    const rawPassword = req.body.password ? String(req.body.password).trim() : '';

    const admin = adminsStore.find(a => a.email.trim().toLowerCase() === rawEmail);

    if (!admin || !bcrypt.compareSync(rawPassword, admin.password_hash)) {
      return res.status(401).render('login.html', { error: 'Invalid credentials' });
    }

    (req.session as any).adminId = admin.id;
    res.redirect('/admin/');
  });

  app.post('/admin/logout', (req: Request, res: Response) => {
    req.session.destroy(() => {
      res.redirect('/admin/login');
    });
  });

  app.get('/admin/', requireAdmin, (req: Request, res: Response) => {
    const q = (req.query.q as string || '').toLowerCase().trim();

    const allFiles = Array.from(filesStore.values()).map(f => ({
      ...f,
      missing: !fs.existsSync(f.path)
    }));

    const filteredFiles = q
      ? allFiles.filter(f => f.name.toLowerCase().includes(q))
      : allFiles;

    // Sort by creation date descending
    filteredFiles.sort((a, b) => b.created_at.getTime() - a.created_at.getTime());

    const activeFilesCount = allFiles.filter(f => !f.disabled && (!f.expires_at || f.expires_at > new Date())).length;
    const totalDownloads = allFiles.reduce((acc, f) => acc + f.downloads, 0);

    const stats = {
      total_files: allFiles.length,
      total_downloads: totalDownloads,
      active_files: activeFilesCount
    };

    const topFiles = [...allFiles]
      .filter(f => !f.disabled)
      .sort((a, b) => b.downloads - a.downloads)
      .slice(0, 5);

    const recentFiles = [...allFiles]
      .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())
      .slice(0, 5);

    const expiringFiles = [...allFiles]
      .filter(f => f.expires_at && f.expires_at > new Date())
      .sort((a, b) => a.expires_at!.getTime() - b.expires_at!.getTime())
      .slice(0, 5);

    res.render('dashboard.html', {
      stats,
      files: filteredFiles,
      top_files: topFiles,
      recent_files: recentFiles,
      expiring_files: expiringFiles,
      query: q
    });
  });

  app.get('/admin/settings', requireAdmin, (req: Request, res: Response) => {
    const allFiles = Array.from(filesStore.values());
    const usedBytes = allFiles.reduce((acc, f) => acc + (f.file_size || 0), 0);
    const totalFiles = allFiles.length;
    const largestFile = allFiles.reduce((max, f) => Math.max(max, f.file_size || 0), 0);

    res.render('settings.html', {
      used_bytes: usedBytes,
      total_files: totalFiles,
      largest_file: largestFile,
      cleanup_enabled: true
    });
  });

  app.post('/admin/settings/save', requireAdmin, (req: Request, res: Response) => {
    res.redirect('/admin/settings');
  });

  app.post('/admin/file/:file_id/delete', requireAdmin, (req: Request, res: Response) => {
    const fileId = req.params.file_id;
    const file = filesStore.get(fileId);
    if (file) {
      if (fs.existsSync(file.path)) {
        try { fs.unlinkSync(file.path); } catch (e) { /* ignore */ }
      }
      filesStore.delete(fileId);
    }
    res.redirect('/admin/');
  });

  app.post('/admin/file/:file_id/disable', requireAdmin, (req: Request, res: Response) => {
    const fileId = req.params.file_id;
    const file = filesStore.get(fileId);
    if (file) {
      file.disabled = true;
    }
    res.redirect('/admin/');
  });

  app.post('/admin/file/:file_id/enable', requireAdmin, (req: Request, res: Response) => {
    const fileId = req.params.file_id;
    const file = filesStore.get(fileId);
    if (file) {
      file.disabled = false;
      file.expires_at = null;
    }
    res.redirect('/admin/');
  });

  app.post('/admin/file/:file_id/expiry', requireAdmin, (req: Request, res: Response) => {
    const fileId = req.params.file_id;
    const ttlStr = req.body.ttl as string;
    const seconds = parseTTL(ttlStr);

    const file = filesStore.get(fileId);
    if (file && seconds !== null) {
      if (seconds === 0) {
        file.expires_at = null;
      } else {
        file.expires_at = new Date(Date.now() + seconds * 1000);
      }
    }
    res.redirect('/admin/');
  });
}

// Start Server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Telegram File Link Bot server running on http://0.0.0.0:${PORT}`);
});

// Telegram bot (only starts when API_ID, API_HASH and BOT_TOKEN are set).
// A bot failure must never take the web server down.
startBot({
  uploadDir: UPLOAD_DIR,
  maxFileMb: MAX_FILE_MB,
  baseUrl: BASE_URL || `http://localhost:${PORT}`,
  parseTTL,
  registerFile: file => {
    filesStore.set(file.file_id, {
      ...file,
      downloads: 0,
      disabled: false,
      created_at: new Date(),
    });
  },
  setProgress: (fileId, progress, status) => {
    taskProgressStore.set(fileId, { file_id: fileId, progress, status });
  },
  clearProgress: fileId => {
    taskProgressStore.delete(fileId);
  },
}).catch(err => {
  console.error('[Bot] failed to start:', err);
});

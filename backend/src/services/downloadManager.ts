import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { config, DOWNLOAD_TIMEOUT_MS } from '../config.js';
import { inject } from './sinfInjector.js';
import { ChunkedDownloader } from './chunkedDownloader.js';
import { r2Config, packedObjectKey, uploadFile } from './r2Storage.js';
import { packageFileName } from '../utils/packageFileName.js';
import type { DownloadTask, Software, Sinf } from '../types/index.js';

const tasks = new Map<string, DownloadTask>();
const abortControllers = new Map<string, AbortController>();
const chunkDownloaders = new Map<string, ChunkedDownloader>();
const progressListeners = new Map<string, Set<(task: DownloadTask) => void>>();

const PACKAGES_DIR = path.join(config.dataDir, 'packages');
const TASKS_FILE = path.join(config.dataDir, 'tasks.json');
// Legacy file from old code — cleaned up on startup
const LEGACY_DOWNLOADS_FILE = path.join(config.dataDir, 'downloads.json');

// --- Security: path segment validation ---
const SAFE_SEGMENT_RE = /^[a-zA-Z0-9._-]+$/;

/** Validate and sanitize a path segment. Rejects traversal, replaces unsafe chars. */
function safePathSegment(value: string, label: string): string {
  if (!value || value === '.' || value === '..') {
    throw new Error(`Invalid ${label}`);
  }
  if (SAFE_SEGMENT_RE.test(value)) return value;
  const cleaned = value.replace(/[^a-zA-Z0-9._-]/g, '_');
  if (!cleaned || cleaned === '.' || cleaned === '..') {
    throw new Error(`Invalid ${label}`);
  }
  return cleaned;
}

// --- Security: download URL allowlist ---
const ALLOWED_DOWNLOAD_HOSTS_RE = /\.apple\.com$/i;

export function validateDownloadURL(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Invalid download URL');
  }

  if (parsed.protocol !== 'https:') {
    throw new Error('Download URL must use HTTPS');
  }

  if (!ALLOWED_DOWNLOAD_HOSTS_RE.test(parsed.hostname)) {
    throw new Error('Download URL must be from an Apple domain (*.apple.com)');
  }

  if (/^\d+\.\d+\.\d+\.\d+$/.test(parsed.hostname) || parsed.hostname.startsWith('[')) {
    throw new Error('Download URL must not use IP addresses');
  }
}

// --- Security: sanitize task for API responses ---
export function sanitizeTaskForResponse(
  task: DownloadTask,
): Omit<DownloadTask, 'downloadURL' | 'sinfs' | 'iTunesMetadata' | 'filePath'> & { hasFile?: boolean } {
  const { downloadURL, sinfs, iTunesMetadata, filePath, ...safe } = task;
  return {
    ...safe,
    hasFile: (!!filePath && fs.existsSync(filePath)) || (task.r2Status === 'uploaded' && !!task.r2Key),
  };
}

// --- Persistence: save only completed task metadata (no secrets) ---
function persistTasks() {
  const completed = Array.from(tasks.values())
    .filter((t) => t.status === 'completed' && t.filePath)
    .map((t) => ({
      id: t.id,
      software: t.software,
      accountHash: t.accountHash,
      downloadURL: '',
      sinfs: [],
      status: t.status,
      progress: t.progress,
      speed: t.speed,
      filePath: t.filePath,
      createdAt: t.createdAt,
      region: t.region,
      accountEmail: t.accountEmail,
      fileSize: t.fileSize,
      r2Key: t.r2Key,
      r2Status: t.r2Status === 'uploaded' ? 'uploaded' : undefined,
    }));
  const tmp = `${TASKS_FILE}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(completed, null, 2));
    fs.renameSync(tmp, TASKS_FILE);
  } catch (err) {
    console.error('[Persist] Failed to write tasks.json:', err instanceof Error ? err.message : err);
  }
  // Sidecar metadata next to each IPA so files can be re-adopted even if tasks.json is lost
  for (const t of completed) {
    try {
      const meta = `${t.filePath!.replace(/\.ipa$/, '')}.meta.json`;
      // Rewrite when stale so region / R2 state reach the sidecar too
      const body = JSON.stringify(t, null, 2);
      const cur = fs.existsSync(meta) ? fs.readFileSync(meta, 'utf-8') : '';
      if (cur !== body && (fs.existsSync(t.filePath!) || fs.existsSync(meta))) fs.writeFileSync(meta, body);
    } catch {
      // best effort
    }
  }
}

// Auto-cleanup: delete completed files older than configured days
export function runTimeCleanup() {
  const { autoCleanupDays } = config;
  if (autoCleanupDays <= 0) return;
  const cutoff = Date.now() - autoCleanupDays * 24 * 60 * 60 * 1000;

  // Collect IDs first to avoid mutating the map during iteration
  const expiredIds: string[] = [];
  for (const task of tasks.values()) {
    if (task.status === 'completed' && task.filePath && fs.existsSync(task.filePath)) {
      try {
        const stat = fs.statSync(task.filePath);
        if (stat.mtimeMs < cutoff) {
          expiredIds.push(task.id);
        }
      } catch {
        // File inaccessible — skip
      }
    }
  }

  for (const id of expiredIds) {
    console.log(`[Cleanup] Deleting expired task: ${id}`);
    deleteTask(id);
  }
}

// Auto-cleanup: evict oldest completed files when total size exceeds limit
export function runSpaceCleanup() {
  const { autoCleanupMaxMB } = config;
  if (autoCleanupMaxMB <= 0) return;
  const maxBytes = autoCleanupMaxMB * 1024 * 1024;

  let totalBytes = 0;
  const fileTasks: { id: string; size: number; mtimeMs: number }[] = [];

  for (const task of tasks.values()) {
    if (task.status === 'completed' && task.filePath && fs.existsSync(task.filePath)) {
      try {
        const stat = fs.statSync(task.filePath);
        totalBytes += stat.size;
        fileTasks.push({ id: task.id, size: stat.size, mtimeMs: stat.mtimeMs });
      } catch {
        // File inaccessible — skip
      }
    }
  }

  if (totalBytes <= maxBytes) return;

  fileTasks.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const ft of fileTasks) {
    console.log(`[Cleanup] Space limit exceeded, deleting task: ${ft.id}`);
    deleteTask(ft.id);
    totalBytes -= ft.size;
    if (totalBytes <= maxBytes) break;
  }
}

// Schedule daily time-based cleanup at midnight (self-correcting to avoid drift)
function scheduleDailyCleanup() {
  function msUntilMidnight(): number {
    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0);
    return next.getTime() - now.getTime();
  }

  function tick() {
    runTimeCleanup();
    setTimeout(tick, msUntilMidnight());
  }

  setTimeout(tick, msUntilMidnight());
}

function initOnStartup() {
  // Remove legacy downloads.json from old code
  if (fs.existsSync(LEGACY_DOWNLOADS_FILE)) {
    fs.unlinkSync(LEGACY_DOWNLOADS_FILE);
  }

  // Ensure packages dir exists
  fs.mkdirSync(PACKAGES_DIR, { recursive: true });

  // Load completed tasks from previous run
  if (fs.existsSync(TASKS_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf-8'));
      if (Array.isArray(data)) {
        for (const item of data) {
          // Only restore completed tasks whose IPA file still exists
          const local = item.filePath && fs.existsSync(item.filePath);
          const remote = item.r2Status === 'uploaded' && typeof item.r2Key === 'string' && item.r2Key;
          if (item.id && item.status === 'completed' && item.filePath && (local || remote)) {
            const task: DownloadTask = {
              id: item.id,
              software: item.software,
              accountHash: item.accountHash,
              downloadURL: '',
              sinfs: [],
              status: 'completed',
              progress: 100,
              speed: '0 B/s',
              filePath: item.filePath,
              createdAt: item.createdAt,
              region: normalizeRegion(item.region),
              accountEmail: typeof item.accountEmail === 'string' ? item.accountEmail : undefined,
              fileSize: typeof item.fileSize === 'number' ? item.fileSize : undefined,
              r2Key: remote ? item.r2Key : undefined,
              r2Status: remote ? 'uploaded' : undefined,
            };
            tasks.set(task.id, task);
          }
        }
      }
    } catch {
      // Corrupted file — start fresh
    }
  }

  // Clean up orphaned IPA files (files without a task)
  cleanOrphanedPackages();

  // Run time-based cleanup once on startup, then schedule daily
  runTimeCleanup();
  scheduleDailyCleanup();

  if (r2Config?.backfillOnStartup) {
    const pending = Array.from(tasks.values()).filter(
      (t) => t.status === 'completed' && t.r2Status !== 'uploaded' && t.filePath && fs.existsSync(t.filePath),
    );
    if (pending.length) console.log(`[R2] Backfill: queueing ${pending.length} package(s)`);
    for (const t of pending) queueR2Upload(t);
  }
}

// --- R2 upload queue (sequential; one multi-GB upload at a time) ---
let r2Chain: Promise<void> = Promise.resolve();

export function queueR2Upload(task: DownloadTask): void {
  if (!r2Config || !task.filePath) return;
  task.r2Status = 'pending';
  r2Chain = r2Chain.then(() => uploadTaskToR2(task)).catch(() => {});
}

export async function uploadTaskToR2(task: DownloadTask, cfg = r2Config): Promise<void> {
  if (!cfg || !task.filePath || !tasks.has(task.id)) return;
  const local = path.resolve(task.filePath);
  if (!local.startsWith(path.resolve(PACKAGES_DIR) + path.sep) || !fs.existsSync(local)) return;
  const key = packedObjectKey(task.accountEmail, packageFileName(task));
  task.r2Status = 'uploading';
  task.r2Error = undefined;
  notifyProgress(task);
  try {
    const size = await uploadFile(local, key, cfg);
    task.fileSize = size;
    task.r2Key = key;
    task.r2Status = 'uploaded';
    console.log(`[R2] Uploaded ${task.id} -> ${key} (${size} bytes)`);
    if (cfg.deleteLocalAfterUpload && tasks.has(task.id)) {
      fs.unlinkSync(local);
    }
    persistTasks();
  } catch (err) {
    task.r2Status = 'failed';
    task.r2Error = err instanceof Error ? err.message : String(err);
    console.error(`[R2] Upload ${task.id} failed:`, task.r2Error);
  }
  notifyProgress(task);
}

function cleanOrphanedPackages() {
  // Durable storage: never delete completed IPAs. Adopt untracked ones as completed
  // tasks (layout: packages/<accountHash>/<bundleID>/<version>/<id>.ipa) and only
  // remove stale .part temp files.
  const knownPaths = new Set<string>();
  for (const task of tasks.values()) {
    if (task.filePath) knownPaths.add(path.resolve(task.filePath));
  }
  const packagesBase = path.resolve(PACKAGES_DIR);
  let adopted = 0;

  function adopt(fullPath: string) {
    const rel = path.relative(packagesBase, fullPath).split(path.sep);
    const id = path.basename(fullPath, '.ipa');
    let task: DownloadTask | undefined;
    const meta = fullPath.replace(/\.ipa$/, '') + '.meta.json';
    if (fs.existsSync(meta)) {
      try {
        const m = JSON.parse(fs.readFileSync(meta, 'utf-8'));
        if (m && m.software) task = { ...m, id: m.id || id, filePath: fullPath, status: 'completed', progress: 100, speed: '0 B/s', downloadURL: '', sinfs: [] };
      } catch {
        // ignore bad sidecar
      }
    }
    if (!task) {
      if (rel.length !== 4) return;
      const [accountHash, bundleID, version] = rel;
      const st = fs.statSync(fullPath);
      task = {
        id,
        software: {
          id: 0, bundleID, name: bundleID, version, artistName: '', sellerName: '', description: '',
          averageUserRating: 0, userRatingCount: 0, artworkUrl: '', screenshotUrls: [], minimumOsVersion: '',
          releaseDate: '', primaryGenreName: '',
        } as unknown as DownloadTask['software'],
        accountHash,
        downloadURL: '',
        sinfs: [],
        status: 'completed',
        progress: 100,
        speed: '0 B/s',
        filePath: fullPath,
        createdAt: st.mtime.toISOString(),
      };
    }
    if (!tasks.has(task.id)) {
      tasks.set(task.id, task);
      adopted++;
    }
  }

  // IPA already moved to R2: only the sidecar remains
  function adoptRemote(metaPath: string) {
    const ipa = metaPath.replace(/\.meta\.json$/, '.ipa');
    if (fs.existsSync(ipa)) return;
    try {
      const m = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
      if (!m?.software || !m.id || m.r2Status !== 'uploaded' || !m.r2Key || tasks.has(m.id)) return;
      tasks.set(m.id, { ...m, filePath: ipa, status: 'completed', progress: 100, speed: '0 B/s', downloadURL: '', sinfs: [] });
      adopted++;
    } catch {
      // ignore bad sidecar
    }
  }

  function walk(dir: string) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        if (fs.readdirSync(fullPath).length === 0) fs.rmdirSync(fullPath);
      } else if (entry.isFile() && !knownPaths.has(path.resolve(fullPath))) {
        if (/\.part\d*$/.test(entry.name)) {
          fs.unlinkSync(fullPath);
        } else if (entry.name.endsWith('.ipa')) {
          adopt(fullPath);
        } else if (entry.name.endsWith('.meta.json')) {
          adoptRemote(fullPath);
        }
      }
    }
  }

  walk(packagesBase);
  if (adopted > 0) {
    console.log(`[Startup] Adopted ${adopted} untracked IPA file(s)`);
    persistTasks();
  }
}

// Initialize on startup
initOnStartup();

function notifyProgress(task: DownloadTask) {
  const listeners = progressListeners.get(task.id);
  if (listeners) {
    for (const listener of listeners) {
      listener(task);
    }
  }
}

export function addProgressListener(taskId: string, listener: (task: DownloadTask) => void) {
  let listeners = progressListeners.get(taskId);
  if (!listeners) {
    listeners = new Set();
    progressListeners.set(taskId, listeners);
  }
  listeners.add(listener);
}

export function removeProgressListener(taskId: string, listener: (task: DownloadTask) => void) {
  const listeners = progressListeners.get(taskId);
  if (listeners) {
    listeners.delete(listener);
    if (listeners.size === 0) {
      progressListeners.delete(taskId);
    }
  }
}

export function getAllTasks(): DownloadTask[] {
  return Array.from(tasks.values());
}

export function getTask(id: string): DownloadTask | undefined {
  return tasks.get(id);
}

export function deleteTask(id: string): boolean {
  const task = tasks.get(id);
  if (!task) return false;

  // Abort if downloading
  const controller = abortControllers.get(id);
  if (controller) {
    controller.abort();
    abortControllers.delete(id);
  }
  const downloader = chunkDownloaders.get(id);
  if (downloader) {
    downloader.abort();
    chunkDownloaders.delete(id);
  }

  // Remove file if exists, with path safety check
  if (task.filePath) {
    const resolved = path.resolve(task.filePath);
    const packagesBase = path.resolve(PACKAGES_DIR);
    const metaExists = fs.existsSync(resolved.replace(/\.ipa$/, '') + '.meta.json');
    if (resolved.startsWith(packagesBase + path.sep) && (fs.existsSync(resolved) || metaExists)) {
      if (fs.existsSync(resolved)) fs.unlinkSync(resolved);
      const metaPath = resolved.replace(/\.ipa$/, '') + '.meta.json';
      if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);

      // Clean up empty parent directories
      let dir = path.dirname(resolved);
      while (dir !== packagesBase && dir.startsWith(packagesBase)) {
        const contents = fs.readdirSync(dir);
        if (contents.length === 0) {
          fs.rmdirSync(dir);
          dir = path.dirname(dir);
        } else {
          break;
        }
      }
    }
  }

  tasks.delete(id);
  progressListeners.delete(id);
  persistTasks();
  return true;
}

export function pauseTask(id: string): boolean {
  const task = tasks.get(id);
  if (!task || task.status !== 'downloading') return false;

  const controller = abortControllers.get(id);
  if (controller) {
    controller.abort();
    abortControllers.delete(id);
  }
  const downloader = chunkDownloaders.get(id);
  if (downloader) {
    downloader.abort();
    chunkDownloaders.delete(id);
  }

  task.status = 'paused';
  notifyProgress(task);
  return true;
}

export function resumeTask(id: string): boolean {
  const task = tasks.get(id);
  if (!task || task.status !== 'paused') return false;

  startDownload(task);
  return true;
}

export function normalizeRegion(region: unknown): string | undefined {
  if (typeof region !== 'string') return undefined;
  const r = region.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(r) ? r : undefined;
}

export function createTask(
  software: Software,
  accountHash: string,
  downloadURL: string,
  sinfs: Sinf[],
  iTunesMetadata?: string,
  region?: string,
  accountEmail?: string,
): DownloadTask {
  // Validate download URL
  validateDownloadURL(downloadURL);

  // Validate path segments
  safePathSegment(accountHash, 'accountHash');
  safePathSegment(software.bundleID, 'bundleID');
  safePathSegment(software.version, 'version');

  const task: DownloadTask = {
    id: uuidv4(),
    software,
    accountHash,
    downloadURL,
    sinfs,
    iTunesMetadata,
    region: normalizeRegion(region),
    accountEmail: typeof accountEmail === 'string' && accountEmail.trim() ? accountEmail.trim().slice(0, 254) : undefined,
    status: 'pending',
    progress: 0,
    speed: '0 B/s',
    createdAt: new Date().toISOString(),
  };

  tasks.set(task.id, task);
  startDownload(task);
  return task;
}

async function startDownload(task: DownloadTask) {
  // Pre-download cleanup: expire old files + enforce space limit
  runTimeCleanup();
  runSpaceCleanup();

  const controller = new AbortController();
  abortControllers.set(task.id, controller);

  // Set a global timeout for the entire download
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

  task.status = 'downloading';
  task.progress = 0;
  task.speed = '0 B/s';
  task.error = undefined;
  notifyProgress(task);

  // Sanitize path segments
  const safeAccountHash = safePathSegment(task.accountHash, 'accountHash');
  const safeBundleID = safePathSegment(task.software.bundleID, 'bundleID');
  const safeVersion = safePathSegment(task.software.version, 'version');

  const dir = path.join(PACKAGES_DIR, safeAccountHash, safeBundleID, safeVersion);

  // Verify the resolved path is within PACKAGES_DIR
  const resolvedDir = path.resolve(dir);
  const packagesBase = path.resolve(PACKAGES_DIR);
  if (!resolvedDir.startsWith(packagesBase + path.sep)) {
    task.status = 'failed';
    task.error = 'Invalid path';
    clearTimeout(timeout);
    notifyProgress(task);
    return;
  }

  fs.mkdirSync(dir, { recursive: true });

  const filePath = path.join(dir, `${task.id}.ipa`);
  task.filePath = filePath;

  try {
    // Re-validate download URL before fetching
    validateDownloadURL(task.downloadURL);

    const downloader = new ChunkedDownloader(task.downloadURL, filePath, {
      onProgress: (info) => {
        task.speed = info.speed;
        if (info.total > 0) {
          task.progress = Math.round((info.downloaded / info.total) * 100);
        }
        notifyProgress(task);
      },
    });
    chunkDownloaders.set(task.id, downloader);

    await downloader.download(controller.signal);

    chunkDownloaders.delete(task.id);
    abortControllers.delete(task.id);
    clearTimeout(timeout);

    // Inject sinfs
    if (task.sinfs.length > 0) {
      task.status = 'injecting';
      task.progress = 100;
      notifyProgress(task);

      await inject(task.sinfs, filePath, task.iTunesMetadata);
    }

    task.status = 'completed';
    task.progress = 100;

    // Strip sensitive data after successful compile
    task.downloadURL = '';
    task.sinfs = [];
    task.iTunesMetadata = undefined;

    try {
      task.fileSize = fs.statSync(filePath).size;
    } catch {
      // ignore
    }

    // Persist completed task metadata (no secrets)
    persistTasks();
    notifyProgress(task);
    queueR2Upload(task);
  } catch (err) {
    chunkDownloaders.delete(task.id);
    abortControllers.delete(task.id);
    clearTimeout(timeout);

    if (err instanceof Error && err.name === 'AbortError') {
      // Status may have been changed to "paused" externally by pauseTask()
      if ((task.status as string) === 'paused') return;
      task.status = 'failed';
      task.error = 'Download timed out';
      notifyProgress(task);
      return;
    }

    task.status = 'failed';
    console.error(`Download ${task.id} failed:`, err instanceof Error ? err.message : err);
    task.error = 'Download failed';
    notifyProgress(task);
  }
}

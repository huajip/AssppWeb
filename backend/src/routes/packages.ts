import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { config } from '../config.js';
import { MIN_ACCOUNT_HASH_LENGTH } from '../config.js';
import { getAllTasks } from '../services/downloadManager.js';
import { getIdParam } from '../utils/route.js';
import { createDownloadToken } from '../utils/downloadLink.js';
import type { PackageInfo } from '../types/index.js';

const router = Router();

// Strip control chars, quotes, slashes and other filesystem-unsafe chars (keeps Unicode)
export function sanitizeFilename(name: string): string {
  return name
    .replace(/[\x00-\x1F\x7F"\\/:*?<>|]/g, '-')
    .trim()
    .slice(0, 200);
}

// {name}_{bundleID}_{version}_{region}.ipa — region omitted when unknown (legacy tasks)
// Keep in sync with frontend packageFileName (components/Download/PackageQuickActions.tsx)
export function packageFileName(task: { software: { name: string; bundleID: string; version: string }; region?: string }): string {
  const parts = [task.software.name, task.software.bundleID, task.software.version, task.region]
    .filter((p): p is string => typeof p === 'string' && p.trim() !== '')
    .map((p) => p.replace(/_+/g, '-').replace(/\s+/g, ' ').trim());
  return `${sanitizeFilename(parts.join('_'))}.ipa`;
}

// RFC 6266 / RFC 5987: ASCII fallback in filename=, UTF-8 in filename* (Safari/Chrome/Firefox honor filename*)
export function contentDisposition(fileName: string): string {
  const safe = sanitizeFilename(fileName) || 'download.ipa';
  let ascii = safe.replace(/[^\x20-\x7E]/g, '_').replace(/_+/g, '_');
  if (!/[A-Za-z0-9]/.test(ascii.replace(/\.ipa$/i, '').replace(/[\d._-]/g, ''))) ascii = `app${ascii.startsWith('_') ? '' : '_'}${ascii}`;
  const encoded = encodeURIComponent(safe).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

// List packages filtered by account hashes
router.get('/packages', (req: Request, res: Response) => {
  const hashesParam = req.query.accountHashes;
  if (!hashesParam || typeof hashesParam !== 'string') {
    res.json([]);
    return;
  }
  const hashes = new Set(hashesParam.split(',').filter(Boolean));
  if (hashes.size === 0) {
    res.json([]);
    return;
  }

  const packages: Omit<PackageInfo, 'filePath'>[] = [];
  const completedTasks = getAllTasks().filter(
    (t) => t.status === 'completed' && t.filePath && hashes.has(t.accountHash),
  );

  for (const task of completedTasks) {
    if (!task.filePath || !fs.existsSync(task.filePath)) continue;

    const stats = fs.statSync(task.filePath);
    packages.push({
      id: task.id,
      software: task.software,
      accountHash: task.accountHash,
      fileSize: stats.size,
      createdAt: task.createdAt,
    });
  }

  res.json(packages);
});

// Issue a short-lived signed download link (requires access auth + accountHash)
router.post('/packages/:id/download-link', (req: Request, res: Response) => {
  const accountHash = (req.query.accountHash ?? req.body?.accountHash) as string;
  if (!accountHash || accountHash.length < MIN_ACCOUNT_HASH_LENGTH) {
    res.status(400).json({ error: 'Missing or invalid accountHash' });
    return;
  }
  const id = getIdParam(req);
  const task = getAllTasks().find((t) => t.id === id && t.status === 'completed');
  if (!task || !task.filePath || !fs.existsSync(task.filePath)) {
    res.status(404).json({ error: 'Package not found' });
    return;
  }
  if (task.accountHash !== accountHash) {
    res.status(403).json({ error: 'Access denied' });
    return;
  }
  const { exp, sig } = createDownloadToken(id, accountHash);
  const params = new URLSearchParams({ accountHash, exp: String(exp), sig });
  res.json({ url: `/api/packages/${encodeURIComponent(id)}/file?${params}`, expiresAt: exp });
});

// Stream IPA file (requires accountHash)
router.get('/packages/:id/file', (req: Request, res: Response) => {
  const accountHash = req.query.accountHash as string;
  if (!accountHash || accountHash.length < MIN_ACCOUNT_HASH_LENGTH) {
    res.status(400).json({ error: 'Missing or invalid accountHash' });
    return;
  }

  const id = getIdParam(req);
  const task = getAllTasks().find((t) => t.id === id && t.status === 'completed');

  if (!task || !task.filePath || !fs.existsSync(task.filePath)) {
    res.status(404).json({ error: 'Package not found' });
    return;
  }

  if (task.accountHash !== accountHash) {
    res.status(403).json({ error: 'Access denied' });
    return;
  }

  // Verify file path is within packages directory
  const packagesBase = path.resolve(path.join(config.dataDir, 'packages'));
  const resolvedPath = path.resolve(task.filePath);
  if (!resolvedPath.startsWith(packagesBase + path.sep)) {
    res.status(403).json({ error: 'Access denied' });
    return;
  }

  const fileName = packageFileName(task);
  res.setHeader('Content-Disposition', contentDisposition(fileName));
  res.setHeader('Content-Type', 'application/octet-stream');

  res.sendFile(resolvedPath, { acceptRanges: true, dotfiles: 'allow', headers: { 'Cache-Control': 'private, no-store' } }, (err) => {
    if (err && !res.headersSent) res.status(500).json({ error: 'Failed to send file' });
  });
});

// Delete a package (requires accountHash)
router.delete('/packages/:id', (req: Request, res: Response) => {
  const accountHash = req.query.accountHash as string;
  if (!accountHash || accountHash.length < MIN_ACCOUNT_HASH_LENGTH) {
    res.status(400).json({ error: 'Missing or invalid accountHash' });
    return;
  }

  const id = getIdParam(req);
  const packagesDir = path.join(config.dataDir, 'packages');
  const packagesBase = path.resolve(packagesDir);

  const task = getAllTasks().find((t) => t.id === id);
  if (!task || !task.filePath) {
    res.status(404).json({ error: 'Package not found' });
    return;
  }

  if (task.accountHash !== accountHash) {
    res.status(403).json({ error: 'Access denied' });
    return;
  }

  // Verify file path is within packages directory
  const resolvedPath = path.resolve(task.filePath);
  if (!resolvedPath.startsWith(packagesBase + path.sep)) {
    res.status(403).json({ error: 'Access denied' });
    return;
  }

  if (fs.existsSync(resolvedPath)) {
    fs.unlinkSync(resolvedPath);

    // Clean up empty parent directories
    let dir = path.dirname(resolvedPath);
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

  res.json({ success: true });
});

export default router;

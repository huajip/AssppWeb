import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { config } from '../config.js';
import { MIN_ACCOUNT_HASH_LENGTH } from '../config.js';
import { getAllTasks, deleteTask } from '../services/downloadManager.js';
import { getIdParam } from '../utils/route.js';
import { createDownloadToken } from '../utils/downloadLink.js';
import { sanitizeFilename, packageFileName } from '../utils/packageFileName.js';
import { r2Enabled, presignGet } from '../services/r2Storage.js';
import type { PackageInfo } from '../types/index.js';

const router = Router();

export { sanitizeFilename, packageFileName } from '../utils/packageFileName.js';

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
    const local = !!task.filePath && fs.existsSync(task.filePath);
    const remote = task.r2Status === 'uploaded' && !!task.r2Key;
    if (!local && !remote) continue;

    const fileSize = local ? fs.statSync(task.filePath!).size : task.fileSize ?? 0;
    packages.push({
      id: task.id,
      software: task.software,
      accountHash: task.accountHash,
      fileSize,
      createdAt: task.createdAt,
    });
  }

  res.json(packages);
});

// Issue a short-lived signed download link (requires access auth + accountHash)
router.post('/packages/:id/download-link', async (req: Request, res: Response) => {
  const accountHash = (req.query.accountHash ?? req.body?.accountHash) as string;
  if (!accountHash || accountHash.length < MIN_ACCOUNT_HASH_LENGTH) {
    res.status(400).json({ error: 'Missing or invalid accountHash' });
    return;
  }
  const id = getIdParam(req);
  const task = getAllTasks().find((t) => t.id === id && t.status === 'completed');
  const remote = !!task && r2Enabled() && task.r2Status === 'uploaded' && !!task.r2Key;
  if (!task || (!remote && (!task.filePath || !fs.existsSync(task.filePath)))) {
    res.status(404).json({ error: 'Package not found' });
    return;
  }
  if (task.accountHash !== accountHash) {
    res.status(403).json({ error: 'Access denied' });
    return;
  }
  if (remote) {
    try {
      // Browser downloads straight from R2 via a short-lived presigned GET
      const { url, expiresAt } = await presignGet(task.r2Key!, packageFileName(task));
      res.json({ url, expiresAt, source: 'r2' });
    } catch (err) {
      console.error('[R2] presign failed:', err instanceof Error ? err.message : err);
      res.status(502).json({ error: 'Failed to sign R2 link' });
    }
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

  // R2-backed package: drop the record locally (the R2 object is kept on purpose)
  if (task.r2Status === 'uploaded') deleteTask(id);

  res.json({ success: true });
});

export default router;

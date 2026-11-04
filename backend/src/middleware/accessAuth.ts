import { Request, Response, NextFunction } from 'express';
import { accessPasswordHash, verifyAccessToken } from '../config.js';
import { verifyDownloadToken } from '../utils/downloadLink.js';

export function accessAuth(req: Request, res: Response, next: NextFunction) {
  if (!accessPasswordHash) {
    next();
    return;
  }

  if (req.path.startsWith('/auth/') || req.path.startsWith('/install/')) {
    next();
    return;
  }

  // Signed short-lived download links (GET /packages/:id/file only)
  const m = /^\/packages\/([^/]+)\/file$/.exec(req.path);
  if (m && (req.method === 'GET' || req.method === 'HEAD') && req.query.sig) {
    if (verifyDownloadToken(decodeURIComponent(m[1]), String(req.query.accountHash ?? ''), req.query.exp, req.query.sig)) {
      next();
    } else {
      res.status(401).json({ error: 'Invalid or expired download link' });
    }
    return;
  }

  const token = req.headers['x-access-token'];
  if (typeof token === 'string' && verifyAccessToken(token)) {
    next();
  } else {
    res.status(401).json({ error: 'Unauthorized' });
  }
}

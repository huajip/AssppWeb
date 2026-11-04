import crypto from 'crypto';

const secret = crypto.randomBytes(32);
export const DOWNLOAD_LINK_TTL_MS = 10 * 60 * 1000;

function sign(id: string, accountHash: string, exp: number): string {
  return crypto.createHmac('sha256', secret).update(`${id}\n${accountHash}\n${exp}`).digest('base64url');
}

export function createDownloadToken(id: string, accountHash: string, now = Date.now()) {
  const exp = now + DOWNLOAD_LINK_TTL_MS;
  return { exp, sig: sign(id, accountHash, exp) };
}

export function verifyDownloadToken(id: string, accountHash: string, exp: unknown, sig: unknown, now = Date.now()): boolean {
  if (typeof exp !== 'string' || typeof sig !== 'string' || !id || !accountHash) return false;
  const expNum = Number(exp);
  if (!Number.isFinite(expNum) || expNum < now) return false;
  const expected = Buffer.from(sign(id, accountHash, expNum));
  const given = Buffer.from(sig);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

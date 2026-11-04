import { describe, it, expect } from 'vitest';
import { createDownloadToken, verifyDownloadToken, DOWNLOAD_LINK_TTL_MS } from '../src/utils/downloadLink.js';

describe('download link tokens', () => {
  const hash = 'a'.repeat(64);
  it('accepts valid and rejects tampered/expired', () => {
    const now = 1_000_000;
    const { exp, sig } = createDownloadToken('pkg1', hash, now);
    expect(verifyDownloadToken('pkg1', hash, String(exp), sig, now)).toBe(true);
    expect(verifyDownloadToken('pkg2', hash, String(exp), sig, now)).toBe(false);
    expect(verifyDownloadToken('pkg1', 'b'.repeat(64), String(exp), sig, now)).toBe(false);
    expect(verifyDownloadToken('pkg1', hash, String(exp + 1), sig, now)).toBe(false);
    expect(verifyDownloadToken('pkg1', hash, String(exp), sig, now + DOWNLOAD_LINK_TTL_MS + 1)).toBe(false);
    expect(verifyDownloadToken('pkg1', hash, undefined, sig, now)).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import { readR2Config, packedObjectKey, presignGet, safeKeySegment } from '../src/services/r2Storage.js';

describe('r2Storage', () => {
  it('is disabled without credentials', () => {
    expect(readR2Config({})).toBeNull();
    expect(readR2Config({ R2_ACCOUNT_ID: 'a' })).toBeNull();
  });

  it('defaults bucket, endpoint and flags', () => {
    const c = readR2Config({ R2_ACCOUNT_ID: 'acc', R2_ACCESS_KEY_ID: 'k', R2_SECRET_ACCESS_KEY: 's' })!;
    expect(c.bucket).toBe('assets-cyberwmdx');
    expect(c.endpoint).toBe('https://acc.r2.cloudflarestorage.com');
    expect(c.presignSeconds).toBe(3600);
    expect(c.backfillOnStartup).toBe(false);
    expect(c.deleteLocalAfterUpload).toBe(true);
    const o = readR2Config({ R2_ENDPOINT: 'https://x.example', R2_ACCESS_KEY_ID: 'k', R2_SECRET_ACCESS_KEY: 's', R2_BUCKET: 'b', R2_BACKFILL_ON_STARTUP: 'true', R2_DELETE_LOCAL: 'false' })!;
    expect(o.endpoint).toBe('https://x.example');
    expect(o.bucket).toBe('b');
    expect(o.backfillOnStartup).toBe(true);
    expect(o.deleteLocalAfterUpload).toBe(false);
  });

  it('builds packed object keys under the email', () => {
    expect(packedObjectKey('Foo.Bar+x@Gmail.com', '原神_com.miHoYo.Yuanshen_7.2.0_CN.ipa'))
      .toBe('installer/ipa/packed/foo.bar+x@gmail.com/原神_com.miHoYo.Yuanshen_7.2.0_CN.ipa');
    expect(packedObjectKey(undefined, 'a.ipa')).toBe('installer/ipa/packed/unknown/a.ipa');
    expect(safeKeySegment('../a/b c?#')).toBe('-a-b-c-');
    expect(packedObjectKey('x@y.z', '../evil/x.ipa')).toBe('installer/ipa/packed/x@y.z/..-evil-x.ipa');
  });

  it('presigns a GET with disposition and expiry (offline)', async () => {
    const c = readR2Config({ R2_ACCOUNT_ID: 'acc', R2_ACCESS_KEY_ID: 'AKIDTEST', R2_SECRET_ACCESS_KEY: 'secret' })!;
    const { url, expiresAt } = await presignGet('installer/ipa/packed/a@b.c/原神_x_1_CN.ipa', '原神_x_1_CN.ipa', c);
    const u = new URL(url);
    expect(u.host).toBe('acc.r2.cloudflarestorage.com');
    expect(u.pathname.startsWith('/assets-cyberwmdx/installer/ipa/packed/')).toBe(true);
    expect(u.searchParams.get('X-Amz-Expires')).toBe('3600');
    expect(u.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    expect(u.searchParams.get('response-content-disposition')).toContain("filename*=UTF-8''");
    expect(expiresAt).toBeGreaterThan(Date.now() / 1000);
  });
});

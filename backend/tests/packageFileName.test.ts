import { describe, it, expect } from 'vitest';
import { packageFileName, contentDisposition } from '../src/routes/packages.js';
import { normalizeRegion } from '../src/services/downloadManager.js';

describe('packageFileName', () => {
  it('includes bundle id, version and region', () => {
    expect(packageFileName({ software: { name: '原神', bundleID: 'com.miHoYo.Yuanshen', version: '6.1.0' }, region: 'CN' }))
      .toBe('原神_com.miHoYo.Yuanshen_6.1.0_CN.ipa');
  });
  it('omits region for legacy tasks and cleans illegal chars', () => {
    expect(packageFileName({ software: { name: 'A/B: C_D', bundleID: 'com.x.y', version: '1.0' } }))
      .toBe('A-B- C-D_com.x.y_1.0.ipa');
  });
  it('content-disposition keeps ascii fallback', () => {
    expect(contentDisposition('原神_com.miHoYo.Yuanshen_6.1.0_CN.ipa')).toContain('filename="_com.miHoYo.Yuanshen_6.1.0_CN.ipa"');
  });
});

describe('normalizeRegion', () => {
  it('accepts 2-letter codes only', () => {
    expect(normalizeRegion('jp')).toBe('JP');
    expect(normalizeRegion('143465')).toBeUndefined();
    expect(normalizeRegion(undefined)).toBeUndefined();
  });
});

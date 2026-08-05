/**
 * Startup auth guard (checkAuthConfigured): the server must refuse to boot
 * with a missing/malformed API key in single-key mode, so a keyless deploy
 * fails loudly instead of running a healthy-looking server that rejects every
 * authenticated request (the empty-API_KEY footgun).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkAuthConfigured } from '../src/middleware/security.js';

describe('checkAuthConfigured (startup guard)', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    delete process.env.API_KEY;
    delete process.env.NEURAL_API_KEY;
    delete process.env.MULTI_TENANT_ENABLED;
  });
  afterEach(() => { process.env = { ...saved }; });

  it('fails when no API key is set (single-key mode)', () => {
    const r = checkAuthConfigured();
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/No API_KEY/);
  });

  it('fails when the API key is set but malformed (too short)', () => {
    process.env.API_KEY = 'short';
    const r = checkAuthConfigured();
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/malformed/);
  });

  it('passes with a well-formed API key', () => {
    process.env.API_KEY = 'a'.repeat(45);
    expect(checkAuthConfigured().ok).toBe(true);
  });

  it('accepts NEURAL_API_KEY as the alias', () => {
    process.env.NEURAL_API_KEY = 'a'.repeat(45);
    expect(checkAuthConfigured().ok).toBe(true);
  });

  // NOTE: the multi-tenant bypass (no API key required when MULTI_TENANT_ENABLED)
  // is intentionally NOT unit-tested here — MULTI_TENANT_ENABLED is read once at
  // module load (tenant/types.ts), so flipping process.env after import has no
  // effect. The guard mirrors authMiddleware's own condition, which is covered
  // by the tenant/auth contract tests.
});

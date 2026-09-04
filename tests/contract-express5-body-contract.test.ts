/**
 * Express 5 upgrade (qs advisory fix) — request body contract.
 *
 * Express 5 / body-parser 2 leave `req.body` undefined when no parser
 * consumed the request (no body, or an unmatched content type); Express 4
 * set `{}`. The server restores the Express 4 contract in one middleware
 * right after its parsers, so every validator and handler keeps seeing an
 * object. Executable property: a POST with no body and no content type is
 * handled exactly like a POST of `{}` — same status, never a 500 — on the
 * raw-parsed message endpoint, the JSON-parsed tool endpoint and the MCP
 * endpoint. Runs against the hermetic server from tests/global-setup.ts.
 */
import { describe, it, expect } from 'vitest';

const BASE_URL = process.env.NEURAL_URL || 'http://localhost:6174';
const API_KEY = process.env.NEURAL_API_KEY || 'IzMklkUkoJv+Thkjp+4B9DVqYYkzHCKQCBJD5dzOW0g=';

const post = (path: string, init: { body?: string; contentType?: string } = {}) =>
  fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'X-API-Key': API_KEY,
      ...(init.contentType ? { 'Content-Type': init.contentType } : {}),
    },
    ...(init.body !== undefined ? { body: init.body } : {}),
  });

describe('Express 5 request body contract (req.body is never undefined)', () => {
  for (const path of ['/ai-message', '/api/tools/get_agent_status', '/mcp']) {
    it(`${path}: a POST without a body is handled like a POST of {} — same status, never 5xx`, async () => {
      const bare = await post(path);
      const empty = await post(path, { body: '{}', contentType: 'application/json' });
      const bareText = await bare.text();
      expect(bare.status, `${path} bare: ${bareText.slice(0, 200)}`).toBeLessThan(500);
      expect(bare.status).toBe(empty.status);
      // Both are JSON responses from the application, not an HTML error page from the framework.
      expect(bare.headers.get('content-type') ?? '').toContain('application/json');
      expect(() => JSON.parse(bareText)).not.toThrow();
    });
  }

  it('a handler that destructures req.body sees {} for a bodiless request: DELETE /api/data/retire answers its own 400, not a 500 from a TypeError', async () => {
    // The three endpoints above tolerate an undefined body on their own; this
    // one does not — it destructures req.body directly, as several operator
    // routes do — so it is the executable proof that the restored Express 4
    // default reaches every handler.
    const bare = await fetch(`${BASE_URL}/api/data/retire`, { method: 'DELETE', headers: { 'X-API-Key': API_KEY } });
    const empty = await fetch(`${BASE_URL}/api/data/retire`, { method: 'DELETE', headers: { 'X-API-Key': API_KEY, 'Content-Type': 'application/json' }, body: '{}' });
    expect(bare.status).toBe(400);
    expect(bare.status).toBe(empty.status);
    expect(await bare.json()).toEqual(await empty.json());
    expect((await (await fetch(`${BASE_URL}/api/data/retire`, { method: 'DELETE', headers: { 'X-API-Key': API_KEY } })).json()).error).toBe('entityNames array is required');
  });

  it('an unmatched content type on a JSON route is handled like an empty body, not a 415/500', async () => {
    const res = await post('/api/tools/get_agent_status', { body: 'x=1', contentType: 'text/plain' });
    const empty = await post('/api/tools/get_agent_status', { body: '{}', contentType: 'application/json' });
    expect(res.status).toBeLessThan(500);
    expect(res.status).toBe(empty.status);
  });
});

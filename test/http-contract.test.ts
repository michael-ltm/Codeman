/**
 * Live-server tests for the stable HTTP contract (docs/api-reference.md):
 * the uniform {success,data} envelope, error envelopes with conventional
 * HTTP statuses, the /api/v1 alias, and the /api not-found handler.
 *
 * These behaviors live in server.ts (preSerialization hook, setNotFoundHandler),
 * which the route-test harness does not install — so they need a real WebServer.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebServer } from '../src/web/server.js';

const PORT = 3168;

describe('Stable HTTP contract (live server)', () => {
  let server: WebServer;
  const base = `http://localhost:${PORT}`;

  beforeAll(async () => {
    server = new WebServer(PORT, false, true);
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  it('wraps bare payloads as { success: true, data }', async () => {
    const res = await fetch(`${base}/api/status`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data).toBeDefined();
    expect(body.data.version).toBeDefined();
  });

  it('serves the same envelope on the /api/v1 alias', async () => {
    const res = await fetch(`${base}/api/v1/status`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.version).toBeDefined();
  });

  it('maps error envelopes to conventional HTTP statuses', async () => {
    const res = await fetch(`${base}/api/sessions/nonexistent/terminal`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(typeof body.error).toBe('string');
    expect(body.errorCode).toBe('NOT_FOUND');
  });

  it('returns a contract-shaped 404 for unknown /api routes', async () => {
    const res = await fetch(`${base}/api/this-route-does-not-exist`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('NOT_FOUND');
  });

  it('returns a contract-shaped 404 for unknown /api/v1 routes', async () => {
    const res = await fetch(`${base}/api/v1/this-route-does-not-exist`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('NOT_FOUND');
  });

  it('rejects a bad /api/events/subscribe body with an error envelope', async () => {
    const res = await fetch(`${base}/api/events/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('INVALID_INPUT');
  });

  it('keeps validation errors on the envelope with HTTP 400', async () => {
    const res = await fetch(`${base}/api/clipboard`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('INVALID_INPUT');
  });
});

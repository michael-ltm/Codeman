/**
 * @fileoverview Clipboard routes.
 * Accepts text via POST and broadcasts to connected browsers for clipboard write.
 */

import { FastifyInstance } from 'fastify';
import { SseEvent } from '../sse-events.js';
import type { EventPort } from '../ports/index.js';

export function registerClipboardRoutes(app: FastifyInstance, ctx: EventPort): void {
  app.post('/api/clipboard', async (req) => {
    const body = req.body as { text?: string; sessionId?: string };
    const text = body?.text;
    if (typeof text !== 'string' || text.length === 0) {
      return { success: false, error: 'Missing or empty "text" field' };
    }
    ctx.broadcast(SseEvent.ClipboardWrite, {
      text,
      sessionId: body.sessionId ?? null,
      timestamp: Date.now(),
    });
    return { success: true };
  });
}

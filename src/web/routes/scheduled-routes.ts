/**
 * @fileoverview Scheduled run routes.
 * CRUD operations for scheduled autonomous runs with session lifecycle management.
 */

import { FastifyInstance } from 'fastify';
import { statSync } from 'node:fs';
import { ApiErrorCode, createErrorResponse, type ApiResponse } from '../../types.js';
import { ScheduledRunSchema } from '../schemas.js';
import { parseBody } from '../route-helpers.js';
import type { SessionPort, EventPort, InfraPort, ScheduledRun } from '../ports/index.js';

export function registerScheduledRoutes(app: FastifyInstance, ctx: SessionPort & EventPort & InfraPort): void {
  app.get('/api/scheduled', async () => {
    return Array.from(ctx.scheduledRuns.values());
  });

  app.post('/api/scheduled', async (req): Promise<{ run: ScheduledRun } | ApiResponse<never>> => {
    const { prompt, workingDir, durationMinutes } = parseBody(ScheduledRunSchema, req.body, 'Invalid request body');

    // Validate workingDir exists and is a directory
    if (workingDir) {
      try {
        const stat = statSync(workingDir);
        if (!stat.isDirectory()) {
          return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'workingDir is not a directory');
        }
      } catch {
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'workingDir does not exist');
      }
    }

    const run = await ctx.startScheduledRun(prompt, workingDir || process.cwd(), durationMinutes ?? 60);
    return { run };
  });

  app.delete('/api/scheduled/:id', async (req) => {
    const { id } = req.params as { id: string };
    const run = ctx.scheduledRuns.get(id);

    if (!run) {
      return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Scheduled run not found');
    }

    await ctx.stopScheduledRun(id);
    return {};
  });

  app.get('/api/scheduled/:id', async (req) => {
    const { id } = req.params as { id: string };
    const run = ctx.scheduledRuns.get(id);

    if (!run) {
      return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Scheduled run not found');
    }

    return run;
  });
}

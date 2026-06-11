/**
 * @fileoverview File browser and streaming routes.
 * Provides directory listing, file content preview, raw file serving, and tail streaming.
 */

import { FastifyInstance, type FastifyReply } from 'fastify';
import { basename as pathBasename, join } from 'node:path';
import { createReadStream, realpathSync, type ReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import { ApiErrorCode, createErrorResponse, getErrorMessage } from '../../types.js';
import { fileStreamManager } from '../../file-stream-manager.js';
import {
  AttachmentRegistrationError,
  attachmentRegistry,
  registerExternalAttachment,
  type AttachmentRecord,
} from '../../attachment-registry.js';
import { isBlockedAttachmentPath, loadAttachmentGuardConfig } from '../../config/attachment-guard.js';
import { findSessionOrFail, validateSessionFilePath } from '../route-helpers.js';
import { isSensitivePath } from '../sensitive-path.js';
import { SseEvent } from '../sse-events.js';
import type { EventPort, SessionPort } from '../ports/index.js';

const MIME_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  json: 'application/json',
  md: 'text/markdown',
  txt: 'text/plain',
};

function sanitizeDownloadName(fileName: string): string {
  return fileName.replace(/["\\\r\n]/g, '_');
}

function sendRawStream(reply: FastifyReply, content: ReadStream): void {
  const headers = reply.getHeaders();
  reply.hijack();

  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) {
      reply.raw.setHeader(name, value);
    }
  }

  content.on('error', (err) => {
    if (reply.raw.headersSent) {
      reply.raw.destroy(err);
      return;
    }

    reply.raw.statusCode = 500;
    reply.raw.end('Failed to read file');
  });
  content.pipe(reply.raw);
}

async function serveRawFile(
  reply: FastifyReply,
  resolvedPath: string,
  fileName: string,
  extension: string,
  download?: boolean
): Promise<void> {
  const stat = await fs.stat(resolvedPath);
  const content = createReadStream(resolvedPath);
  const safeName = sanitizeDownloadName(fileName);
  if (download || extension === 'svg') {
    reply.header(
      'Content-Type',
      extension === 'svg' ? 'application/octet-stream' : MIME_TYPES[extension] || 'application/octet-stream'
    );
    reply.header('Content-Disposition', `attachment; filename="${safeName}"`);
    reply.header('Content-Length', stat.size);
    reply.header('X-Content-Type-Options', 'nosniff');
    sendRawStream(reply, content);
    return;
  }

  reply.header('Content-Type', MIME_TYPES[extension] || 'application/octet-stream');
  reply.header('Content-Disposition', `inline; filename="${safeName}"`);
  reply.header('Content-Length', stat.size);
  reply.header('X-Content-Type-Options', 'nosniff');
  sendRawStream(reply, content);
}

function getAttachmentOr404(
  reply: FastifyReply,
  sessionId: string,
  attachmentId: string
): AttachmentRecord | undefined {
  const record = attachmentRegistry.get(sessionId, attachmentId);
  if (!record) {
    reply.code(404).send(createErrorResponse(ApiErrorCode.NOT_FOUND, 'Attachment not found'));
    return undefined;
  }
  return record;
}

/**
 * COD-53 defense-in-depth: refuse to stream a record whose underlying path is
 * blocked by the active attachment-guard policy, even though registration
 * already blocks them. Guards against records that predate the guard or were
 * crafted to point at a sensitive file. Resolves symlinks before the check so a
 * record pointing at a symlink that now resolves to a sensitive target is also
 * caught; if the path can't be resolved (deleted/unreadable) the check still
 * runs on the stored path. When workspace confinement is enabled it additionally
 * rejects any record outside the session workspace. Returns true (and sends a
 * 403) when blocked.
 */
async function rejectIfSensitiveRecord(
  reply: FastifyReply,
  record: AttachmentRecord,
  sessionWorkingDir?: string
): Promise<boolean> {
  let pathToCheck = record.filePath;
  try {
    pathToCheck = realpathSync(record.filePath);
  } catch {
    // Fall back to the stored (already realpath-resolved at registration) path.
  }

  const guard = await loadAttachmentGuardConfig();

  const blocked =
    isBlockedAttachmentPath(pathToCheck, guard.blockedTrees) ||
    isBlockedAttachmentPath(record.filePath, guard.blockedTrees) ||
    (guard.confineToWorkspace && (!sessionWorkingDir || !validateSessionFilePath(sessionWorkingDir, pathToCheck)));

  if (blocked) {
    reply.code(403).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Access to this file is blocked'));
    return true;
  }
  return false;
}

export function registerFileRoutes(app: FastifyInstance, ctx: SessionPort & EventPort): void {
  // File tree listing
  app.get('/api/sessions/:id/files', async (req) => {
    const { id } = req.params as { id: string };
    const { depth, showHidden } = req.query as { depth?: string; showHidden?: string };
    const session = findSessionOrFail(ctx, id);

    const maxDepth = Math.min(parseInt(depth || '5', 10), 10);
    const includeHidden = showHidden === 'true';
    const workingDir = session.workingDir;

    // Default excludes - large/generated directories
    const excludeDirs = new Set([
      '.git',
      'node_modules',
      'dist',
      'build',
      '__pycache__',
      '.cache',
      '.next',
      '.nuxt',
      'coverage',
      '.venv',
      'venv',
      '.tox',
      'target',
      'vendor',
    ]);

    interface FileTreeNode {
      name: string;
      path: string;
      type: 'file' | 'directory';
      size?: number;
      extension?: string;
      children?: FileTreeNode[];
    }

    let totalFiles = 0;
    let totalDirectories = 0;
    let truncated = false;
    const maxFiles = 5000;

    const scanDirectory = async (dirPath: string, currentDepth: number): Promise<FileTreeNode[]> => {
      if (currentDepth > maxDepth || totalFiles + totalDirectories > maxFiles) {
        truncated = true;
        return [];
      }

      try {
        const entries = await fs.readdir(dirPath, { withFileTypes: true });
        const nodes: FileTreeNode[] = [];

        // Sort: directories first, then alphabetically
        entries.sort((a, b) => {
          if (a.isDirectory() && !b.isDirectory()) return -1;
          if (!a.isDirectory() && b.isDirectory()) return 1;
          return a.name.localeCompare(b.name);
        });

        for (const entry of entries) {
          if (totalFiles + totalDirectories > maxFiles) {
            truncated = true;
            break;
          }

          // Skip hidden files unless requested
          if (!includeHidden && entry.name.startsWith('.')) continue;

          // Skip excluded directories
          if (entry.isDirectory() && excludeDirs.has(entry.name)) continue;

          const fullPath = join(dirPath, entry.name);
          const relativePath = fullPath.slice(workingDir.length + 1);

          if (entry.isDirectory()) {
            totalDirectories++;
            const children = await scanDirectory(fullPath, currentDepth + 1);
            nodes.push({
              name: entry.name,
              path: relativePath,
              type: 'directory',
              children,
            });
          } else {
            totalFiles++;
            const ext = entry.name.includes('.') ? entry.name.split('.').pop()?.toLowerCase() : undefined;
            let size: number | undefined;
            try {
              const stat = await fs.stat(fullPath);
              size = stat.size;
            } catch {
              // Skip if can't stat
            }
            nodes.push({
              name: entry.name,
              path: relativePath,
              type: 'file',
              size,
              extension: ext,
            });
          }
        }

        return nodes;
      } catch {
        // Can't read directory (permission denied, etc.)
        return [];
      }
    };

    const tree = await scanDirectory(workingDir, 1);

    return {
      success: true,
      data: {
        root: workingDir,
        tree,
        totalFiles,
        totalDirectories,
        truncated,
      },
    };
  });

  // Get file content for preview (File Browser)
  app.get('/api/sessions/:id/file-content', async (req) => {
    const { id } = req.params as { id: string };
    const { path: filePath, lines, raw } = req.query as { path?: string; lines?: string; raw?: string };
    const session = findSessionOrFail(ctx, id);

    if (!filePath) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Missing path parameter');
    }

    // Validate path is within working directory (security: resolve symlinks to prevent traversal)
    const validated = validateSessionFilePath(session.workingDir, filePath);
    if (!validated) {
      return createErrorResponse(ApiErrorCode.NOT_FOUND, 'File not found');
    }
    const { resolvedPath } = validated;

    try {
      const stat = await fs.stat(resolvedPath);

      // Check if it's a binary/media file
      const ext = filePath.split('.').pop()?.toLowerCase() || '';
      const binaryExts = new Set([
        'png',
        'jpg',
        'jpeg',
        'gif',
        'webp',
        'ico',
        'svg',
        'bmp',
        'mp4',
        'webm',
        'mov',
        'avi',
        'mp3',
        'wav',
        'ogg',
        'pdf',
        'zip',
        'tar',
        'gz',
        'exe',
        'dll',
        'so',
        'woff',
        'woff2',
        'ttf',
        'eot',
      ]);
      const imageExts = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico']);
      const videoExts = new Set(['mp4', 'webm', 'mov', 'avi']);

      if (raw === 'true' || binaryExts.has(ext)) {
        // Return metadata for binary files
        return {
          success: true,
          data: {
            path: filePath,
            size: stat.size,
            type: imageExts.has(ext) ? 'image' : videoExts.has(ext) ? 'video' : 'binary',
            extension: ext,
            url: `/api/sessions/${id}/file-raw?path=${encodeURIComponent(filePath)}`,
          },
        };
      }

      // Validate file size before reading (DoS protection - prevent memory exhaustion)
      const MAX_TEXT_FILE_SIZE = 10 * 1024 * 1024; // 10MB
      if (stat.size > MAX_TEXT_FILE_SIZE) {
        return createErrorResponse(
          ApiErrorCode.INVALID_INPUT,
          `File too large (${Math.round(stat.size / 1024 / 1024)}MB > ${MAX_TEXT_FILE_SIZE / 1024 / 1024}MB limit)`
        );
      }

      // Read text file with line limit (bounded to prevent DoS)
      const MAX_LINES_LIMIT = 10000;
      const maxLines = Math.min(parseInt(lines || '500', 10) || 500, MAX_LINES_LIMIT);
      const content = await fs.readFile(resolvedPath, 'utf-8');
      const allLines = content.split('\n');
      const truncatedContent = allLines.length > maxLines;
      const displayContent = truncatedContent ? allLines.slice(0, maxLines).join('\n') : content;

      return {
        success: true,
        data: {
          path: filePath,
          content: displayContent,
          size: stat.size,
          totalLines: allLines.length,
          truncated: truncatedContent,
          extension: ext,
        },
      };
    } catch (err) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Failed to read file: ${getErrorMessage(err)}`);
    }
  });

  // Serve raw file content (for images/binary files)
  app.get('/api/sessions/:id/file-raw', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { path: filePath, download } = req.query as { path?: string; download?: string };
    const session = findSessionOrFail(ctx, id);

    if (!filePath) {
      reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Missing path parameter'));
      return;
    }

    // Validate path is within working directory (security: resolve symlinks to prevent traversal)
    const validated = validateSessionFilePath(session.workingDir, filePath);
    if (!validated) {
      reply.code(404).send(createErrorResponse(ApiErrorCode.NOT_FOUND, 'File not found'));
      return;
    }
    const { resolvedPath } = validated;

    try {
      // Validate file size before reading (DoS protection - prevent memory exhaustion)
      const MAX_RAW_FILE_SIZE = 50 * 1024 * 1024; // 50MB for raw files
      const stat = await fs.stat(resolvedPath);
      if (stat.size > MAX_RAW_FILE_SIZE) {
        reply
          .code(400)
          .send(
            createErrorResponse(
              ApiErrorCode.INVALID_INPUT,
              `File too large (${Math.round(stat.size / 1024 / 1024)}MB > ${MAX_RAW_FILE_SIZE / 1024 / 1024}MB limit)`
            )
          );
        return;
      }

      const ext = filePath.split('.').pop()?.toLowerCase() || '';
      const mimeTypes: Record<string, string> = {
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        gif: 'image/gif',
        webp: 'image/webp',
        ico: 'image/x-icon',
        bmp: 'image/bmp',
        mp4: 'video/mp4',
        webm: 'video/webm',
        mov: 'video/quicktime',
        mp3: 'audio/mpeg',
        wav: 'audio/wav',
        ogg: 'audio/ogg',
        pdf: 'application/pdf',
        json: 'application/json',
      };

      const content = await fs.readFile(resolvedPath);
      const rawBasename = filePath!.split('/').pop() || 'download';
      // Sanitize filename for Content-Disposition header (prevent header injection)
      const basename = rawBasename.replace(/["\\\r\n]/g, '_');
      if (download === 'true' || ext === 'svg') {
        reply.raw.writeHead(200, {
          'Content-Type': ext === 'svg' ? 'application/octet-stream' : mimeTypes[ext] || 'application/octet-stream',
          'Content-Disposition': `attachment; filename="${basename}"`,
          'Content-Length': content.length,
          'X-Content-Type-Options': 'nosniff',
        });
        reply.raw.end(content);
        return;
      }
      reply.header('Content-Type', mimeTypes[ext] || 'application/octet-stream');
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.send(content);
    } catch (err) {
      reply
        .code(500)
        .send(createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Failed to read file: ${getErrorMessage(err)}`));
    }
  });

  // ===== Live external attachments =====
  // Register an explicit, live external file (absolute host path) as an
  // attachment with a stable id so browser requests never carry arbitrary
  // paths. Registration enforces the COD-53 attachment-guard policy. Serving is
  // by id via the /raw route below; document previews/thumbnails and the
  // attachment-history list are layered on separately.
  app.post('/api/sessions/:id/attachments', async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = findSessionOrFail(ctx, id);
    const body = (req.body || {}) as { path?: string };

    if (!body.path || typeof body.path !== 'string') {
      reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Missing attachment path'));
      return;
    }

    try {
      const event = await registerExternalAttachment(id, body.path, { sessionWorkingDir: session.workingDir });
      ctx.broadcast(SseEvent.AttachmentDetected, event);
      return { success: true, data: event };
    } catch (err) {
      if (err instanceof AttachmentRegistrationError) {
        reply.code(err.statusCode).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, err.message));
        return;
      }
      return reply
        .code(500)
        .send(
          createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Failed to register attachment: ${getErrorMessage(err)}`)
        );
    }
  });

  // Serve the raw bytes of a registered attachment by id. Re-checks the
  // attachment-guard policy on every request (defense-in-depth) before streaming.
  app.get('/api/sessions/:id/attachments/:attachmentId/raw', async (req, reply) => {
    const { id, attachmentId } = req.params as { id: string; attachmentId: string };
    const { download } = req.query as { download?: string };
    const session = findSessionOrFail(ctx, id);
    const record = getAttachmentOr404(reply, id, attachmentId);
    if (!record) return;
    if (await rejectIfSensitiveRecord(reply, record, session.workingDir)) return;

    try {
      await serveRawFile(reply, record.filePath, record.fileName, record.extension, download === 'true');
    } catch (err) {
      reply
        .code(500)
        .send(createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Failed to read file: ${getErrorMessage(err)}`));
    }
  });

  // Stream file content via tail -f (SSE endpoint)
  app.get('/api/sessions/:id/tail-file', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { path: filePath, lines } = req.query as { path?: string; lines?: string };
    const session = findSessionOrFail(ctx, id);

    if (!filePath) {
      reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Missing path parameter'));
      return;
    }

    // Set up SSE headers
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // Track stream for cleanup
    const streamRef: { id?: string } = {};

    // Create the file stream
    const result = await fileStreamManager.createStream({
      sessionId: id,
      filePath,
      workingDir: session.workingDir,
      lines: lines ? parseInt(lines, 10) : undefined,
      onData: (data) => {
        // Send data as SSE event
        reply.raw.write(`data: ${JSON.stringify({ type: 'data', content: data })}\n\n`);
      },
      onEnd: () => {
        reply.raw.write(`data: ${JSON.stringify({ type: 'end' })}\n\n`);
        reply.raw.end();
      },
      onError: (error) => {
        reply.raw.write(`data: ${JSON.stringify({ type: 'error', error })}\n\n`);
      },
    });

    if (!result.success) {
      reply.raw.write(`data: ${JSON.stringify({ type: 'error', error: result.error })}\n\n`);
      reply.raw.end();
      return;
    }

    streamRef.id = result.streamId;

    // Notify client of successful connection
    reply.raw.write(`data: ${JSON.stringify({ type: 'connected', streamId: result.streamId, filePath })}\n\n`);

    // Handle client disconnect
    req.raw.on('close', () => {
      if (streamRef.id) {
        fileStreamManager.closeStream(streamRef.id);
      }
    });
  });

  // Close a file stream. Returns { closed } rather than { success: closed } —
  // a top-level `success` key would collide with the envelope discriminator
  // (the preSerialization hook would pass `{success:false}` through as a
  // malformed error envelope instead of wrapping it).
  app.delete('/api/sessions/:id/tail-file/:streamId', async (req) => {
    const { id, streamId } = req.params as { id: string; streamId: string };
    findSessionOrFail(ctx, id); // Validates session exists
    const closed = fileStreamManager.closeStream(streamId);
    return { closed };
  });
  // Session-scoped file download.
  // Uses the same realpath-based workspace boundary as file preview/raw routes;
  // the shared sensitive-path blocklist (../sensitive-path.js, also used by the
  // attachment guard) remains defense-in-depth, not the primary boundary.
  app.get('/api/download', async (req, reply) => {
    const { path: filePath, sessionId } = req.query as { path?: string; sessionId?: string };

    if (!filePath) {
      reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Missing path parameter'));
      return;
    }

    if (!sessionId) {
      reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Missing sessionId parameter'));
      return;
    }

    const session = findSessionOrFail(ctx, sessionId);
    const validated = validateSessionFilePath(session.workingDir, filePath);
    if (!validated) {
      reply.code(404).send(createErrorResponse(ApiErrorCode.NOT_FOUND, 'File not found'));
      return;
    }
    const { resolvedPath } = validated;

    // Check sensitive path blocklist
    if (isSensitivePath(resolvedPath)) {
      reply.code(403).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Access to this file is blocked'));
      return;
    }

    try {
      const stat = await fs.stat(resolvedPath);

      if (!stat.isFile()) {
        reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Path is not a file'));
        return;
      }

      // 50MB size limit
      const MAX_DOWNLOAD_SIZE = 50 * 1024 * 1024;
      if (stat.size > MAX_DOWNLOAD_SIZE) {
        reply
          .code(400)
          .send(
            createErrorResponse(
              ApiErrorCode.INVALID_INPUT,
              `File too large (${Math.round(stat.size / 1024 / 1024)}MB > 50MB limit)`
            )
          );
        return;
      }

      const ext = filePath.split('.').pop()?.toLowerCase() || '';
      const mimeTypes: Record<string, string> = {
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        gif: 'image/gif',
        webp: 'image/webp',
        svg: 'image/svg+xml',
        pdf: 'application/pdf',
        json: 'application/json',
        txt: 'text/plain',
        md: 'text/markdown',
        csv: 'text/csv',
        xml: 'application/xml',
        zip: 'application/zip',
        gz: 'application/gzip',
        tar: 'application/x-tar',
      };

      const filename = pathBasename(resolvedPath);
      const content = await fs.readFile(resolvedPath);
      // Bypass Fastify compression — write directly to raw response
      reply.raw.writeHead(200, {
        'Content-Type': mimeTypes[ext] || 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': content.length,
      });
      reply.raw.end(content);
      return;
    } catch (err) {
      reply
        .code(500)
        .send(createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Failed to read file: ${getErrorMessage(err)}`));
    }
  });
}

/**
 * @fileoverview In-memory attachment registry for live external document references.
 *
 * Session-local files keep using the existing workspace-scoped file routes. This
 * registry is only for explicit, live external attachments that need a stable ID
 * so browser requests never contain arbitrary absolute paths.
 */

import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import fs from 'node:fs/promises';
import { basename, extname, isAbsolute } from 'node:path';
import { isBlockedAttachmentPath, loadAttachmentGuardConfig } from './config/attachment-guard.js';
import { validateSessionFilePath } from './web/route-helpers.js';
import type { AttachmentDetectedEvent, AttachmentDetectedType } from './types.js';

const SUPPORTED_ATTACHMENT_EXTENSIONS = new Set(['png', 'pdf', 'docx', 'pptx', 'md', 'txt']);

export type AttachmentSource = 'detected' | 'external';

export interface AttachmentRecord {
  attachmentId: string;
  sessionId: string;
  filePath: string;
  fileName: string;
  extension: string;
  attachmentType: AttachmentDetectedType;
  size: number;
  mtimeMs: number;
  timestamp: number;
  source: AttachmentSource;
}

export interface AttachmentRegistrationResult extends AttachmentDetectedEvent {
  attachmentId: string;
  source: AttachmentSource;
  rawUrl: string;
  previewUrl: string;
  thumbnailUrl: string;
}

export class AttachmentRegistrationError extends Error {
  constructor(
    message: string,
    readonly statusCode: number = 400
  ) {
    super(message);
  }
}

class AttachmentRegistry {
  private recordsBySession = new Map<string, Map<string, AttachmentRecord>>();

  register(record: AttachmentRecord): void {
    let records = this.recordsBySession.get(record.sessionId);
    if (!records) {
      records = new Map();
      this.recordsBySession.set(record.sessionId, records);
    }
    records.set(record.attachmentId, record);
  }

  get(sessionId: string, attachmentId: string): AttachmentRecord | undefined {
    return this.recordsBySession.get(sessionId)?.get(attachmentId);
  }

  findByFilePath(sessionId: string, filePath: string): AttachmentRecord | undefined {
    const records = this.recordsBySession.get(sessionId);
    if (!records) return undefined;
    for (const record of records.values()) {
      if (record.filePath === filePath) return record;
    }
    return undefined;
  }

  clearSession(sessionId: string): void {
    this.recordsBySession.delete(sessionId);
  }
}

export const attachmentRegistry = new AttachmentRegistry();

export function isSupportedAttachmentExtension(extension: string): boolean {
  return SUPPORTED_ATTACHMENT_EXTENSIONS.has(extension.toLowerCase().replace(/^\./, ''));
}

export function getAttachmentType(extension: string): AttachmentDetectedType {
  const normalized = extension.toLowerCase().replace(/^\./, '');
  if (normalized === 'png') return 'image';
  if (normalized === 'pdf') return 'pdf';
  if (normalized === 'pptx') return 'presentation';
  if (normalized === 'md') return 'markdown';
  if (normalized === 'txt') return 'text';
  return 'document';
}

export function buildAttachmentRoutes(
  sessionId: string,
  attachmentId: string
): {
  rawUrl: string;
  previewUrl: string;
  thumbnailUrl: string;
} {
  const encodedId = encodeURIComponent(attachmentId);
  return {
    rawUrl: `/api/sessions/${sessionId}/attachments/${encodedId}/raw`,
    previewUrl: `/api/sessions/${sessionId}/attachments/${encodedId}/preview`,
    thumbnailUrl: `/api/sessions/${sessionId}/attachments/${encodedId}/thumbnail`,
  };
}

export function buildFileThumbnailRoute(sessionId: string, relativePath: string): string {
  return `/api/sessions/${sessionId}/file-thumbnail?path=${encodeURIComponent(relativePath)}`;
}

export function attachmentRecordToEvent(record: AttachmentRecord): AttachmentRegistrationResult {
  const routes = buildAttachmentRoutes(record.sessionId, record.attachmentId);
  return {
    sessionId: record.sessionId,
    filePath: record.fileName,
    relativePath: '',
    fileName: record.fileName,
    extension: record.extension,
    attachmentType: record.attachmentType,
    timestamp: record.timestamp,
    size: record.size,
    attachmentId: record.attachmentId,
    source: record.source,
    ...routes,
  };
}

/** Options for {@link registerExternalAttachment}. */
export interface RegisterExternalAttachmentOptions {
  /**
   * The registering session's working directory. Required only to enforce
   * workspace confinement when that mode is enabled
   * (`attachmentConfineToWorkspace` / `CODEMAN_ATTACHMENT_CONFINE`); ignored in
   * the default blocklist mode.
   */
  sessionWorkingDir?: string;
}

export async function registerExternalAttachment(
  sessionId: string,
  requestedPath: string,
  options: RegisterExternalAttachmentOptions = {}
): Promise<AttachmentRegistrationResult> {
  if (!requestedPath || !isAbsolute(requestedPath)) {
    throw new AttachmentRegistrationError('Attachment path must be an absolute local path');
  }

  let resolvedPath: string;
  try {
    resolvedPath = realpathSync(requestedPath);
  } catch {
    throw new AttachmentRegistrationError('Attachment file not found', 404);
  }

  // COD-53: enforce the active attachment-guard policy on the symlink-resolved
  // path before doing anything else.
  const guard = await loadAttachmentGuardConfig();

  if (guard.confineToWorkspace) {
    // Strict mode (opt-in, default OFF): the file MUST resolve inside the
    // session's workspace. Strictly more restrictive than the blocklist —
    // breaks cross-workspace attachment, which is why it is off by default.
    const workingDir = options.sessionWorkingDir;
    if (!workingDir || !validateSessionFilePath(workingDir, resolvedPath)) {
      throw new AttachmentRegistrationError('Access to this file is blocked', 403);
    }
  }

  // Blocklist (DEFAULT, also applied alongside confinement as defense in
  // depth): pre-populated secret locations + the /root and /etc trees + any
  // operator-configured extra trees. Symlinks are already resolved above.
  // Cross-workspace attachment of non-blocked files stays allowed, so
  // codeman-publish and the ~/.codeman review loop keep working.
  if (isBlockedAttachmentPath(resolvedPath, guard.blockedTrees)) {
    throw new AttachmentRegistrationError('Access to this file is blocked', 403);
  }

  const extension = extname(resolvedPath).toLowerCase().replace(/^\./, '');
  if (!isSupportedAttachmentExtension(extension)) {
    throw new AttachmentRegistrationError('Unsupported attachment type');
  }

  const stat = await fs.stat(resolvedPath);
  if (typeof stat.isFile === 'function' && !stat.isFile()) {
    throw new AttachmentRegistrationError('Attachment path is not a file');
  }

  const existing = attachmentRegistry.findByFilePath(sessionId, resolvedPath);
  if (existing) {
    existing.size = stat.size;
    existing.mtimeMs = stat.mtimeMs ?? 0;
    existing.timestamp = Date.now();
    return attachmentRecordToEvent(existing);
  }

  const record: AttachmentRecord = {
    attachmentId: `att_${randomUUID()}`,
    sessionId,
    filePath: resolvedPath,
    fileName: basename(resolvedPath),
    extension,
    attachmentType: getAttachmentType(extension),
    size: stat.size,
    mtimeMs: stat.mtimeMs ?? 0,
    timestamp: Date.now(),
    source: 'external',
  };
  attachmentRegistry.register(record);
  return attachmentRecordToEvent(record);
}

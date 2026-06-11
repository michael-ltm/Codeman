/**
 * @fileoverview Parses terminal magic links that request attachment cards.
 */

import { isAbsolute } from 'node:path';
import { isSupportedAttachmentExtension } from './attachment-registry.js';

const MAGIC_LINK_RE = /codeman:\/\/attach\?([^\s<>"']+)/g;

export function parseAttachmentMagicLinks(data: string): string[] {
  const results: string[] = [];
  const seen = new Set<string>();

  for (const match of data.matchAll(MAGIC_LINK_RE)) {
    const query = trimTrailingPunctuation(match[1] || '');
    try {
      const params = new URLSearchParams(query);
      const filePath = params.get('path');
      if (!filePath || !isAbsolute(filePath)) continue;
      const extension = filePath.split('.').pop()?.toLowerCase() || '';
      if (!isSupportedAttachmentExtension(extension)) continue;
      if (seen.has(filePath)) continue;
      seen.add(filePath);
      results.push(filePath);
    } catch {
      // Ignore malformed terminal text. Magic links are advisory.
    }
  }

  return results;
}

function trimTrailingPunctuation(value: string): string {
  return value.replace(/[),.;:]+$/g, '');
}

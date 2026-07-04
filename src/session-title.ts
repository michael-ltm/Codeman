import { extractUserPromptFromEntry } from './web/history-sessions-core.js';

/** Turn one raw user input line into the same compact title used by transcript extraction. */
export function deriveSessionConversationTitleFromText(text: string): string | undefined {
  return extractUserPromptFromEntry({ type: 'user', message: { content: text } });
}

/** Derive a compact, Warp-like title for a live session from its first meaningful user prompt. */
export function deriveSessionConversationTitle(messages: readonly unknown[]): string | undefined {
  for (const message of messages) {
    const prompt = extractUserPromptFromEntry(message);
    if (prompt) return prompt;
  }
  return undefined;
}

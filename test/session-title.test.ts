import { describe, it, expect } from 'vitest';
import { deriveSessionConversationTitle, deriveSessionConversationTitleFromText } from '../src/session-title.js';
import { extractFirstUserPrompt } from '../src/web/history-sessions-core.js';

describe('session conversation titles', () => {
  it('derives the first meaningful user prompt from live session messages', () => {
    const title = deriveSessionConversationTitle([
      {
        type: 'system',
        message: { content: [{ type: 'text', text: 'system setup' }] },
      },
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'text',
              text: '<system-reminder>ignored</system-reminder>\n调查号码掉线问题\n需要看日志',
            },
          ],
        },
      },
    ]);

    expect(title).toBe('调查号码掉线问题 需要看日志');
  });

  it('shares filtering with history transcript prompt extraction', () => {
    const head = [
      JSON.stringify({ type: 'user', message: { content: '/clear' } }),
      JSON.stringify({ type: 'user', message: { content: '分析和优化 eBay 采集任务，重点看增量同步和重试逻辑' } }),
    ].join('\n');

    expect(extractFirstUserPrompt(head)).toBe('分析和优化 eBay 采集任务，重点看增量同步和重试逻辑');
    expect(
      deriveSessionConversationTitle([
        { type: 'user', message: { content: '/clear' } },
        { type: 'user', message: { content: '分析和优化 eBay 采集任务，重点看增量同步和重试逻辑' } },
      ])
    ).toBe('分析和优化 eBay 采集任务，重点看增量同步和重试逻辑');
  });

  it('derives a title from raw interactive input lines', () => {
    expect(deriveSessionConversationTitleFromText('清理机器人卡片缓存记录\r')).toBe('清理机器人卡片缓存记录');
    expect(deriveSessionConversationTitleFromText('/clear')).toBeUndefined();
  });
});

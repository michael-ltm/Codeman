/**
 * @fileoverview Renders ToolResult[] from the dependency checker into a
 * human-readable grouped table or JSON, and computes the process exit code.
 * Plain text only (no color) so output is stable and snapshot-friendly; the
 * CLI layer may colorize.
 *
 * @module utils/dependency-report
 */

import type { ProbeEnvironment, ToolCategory } from '../config/dependency-registry.js';
import type { ToolResult, ToolStatus } from './dependency-checker.js';

const CATEGORY_ORDER: ToolCategory[] = ['core', 'office', 'other'];

function glyph(r: ToolResult): string {
  if (r.status === 'ok') return '✓';
  if (r.status === 'skipped') return '○';
  return r.required ? '✗' : '○';
}

function statusText(r: ToolResult): string {
  if (r.status === 'ok') return r.version ?? 'installed';
  if (r.status === 'outdated') return `${r.version ?? '?'} (below minimum)`;
  if (r.status === 'skipped') return 'n/a';
  if (r.status === 'error') return 'version error';
  return 'not found';
}

export function computeExitCode(results: ToolResult[]): number {
  const failed = results.some(
    (r) => r.required && (r.status === 'missing' || r.status === 'outdated' || r.status === 'error')
  );
  return failed ? 1 : 0;
}

export function renderTable(results: ToolResult[], environment: ProbeEnvironment): string {
  const lines: string[] = [`Codeman dependency check — ${environment}`, ''];
  for (const category of CATEGORY_ORDER) {
    const rows = results.filter((r) => r.category === category);
    if (rows.length === 0) continue;
    lines.push(category.toUpperCase());
    for (const r of rows) {
      const detail = r.path ? `  ${r.path}` : '';
      lines.push(`  ${glyph(r)} ${r.label.padEnd(14)} ${statusText(r).padEnd(22)}${detail}`);
      if (r.usedBy.length) lines.push(`        used by: ${r.usedBy.join(', ')}`);
      if (r.installHint) lines.push(`        install: ${r.installHint}`);
    }
    lines.push('');
  }
  const ok = results.filter((r) => r.status === 'ok').length;
  const requiredMissing = results.filter((r) => r.required && r.status !== 'ok' && r.status !== 'skipped').length;
  const optionalMissing = results.filter((r) => !r.required && r.status === 'missing').length;
  lines.push(`Summary: ${ok} ok · ${requiredMissing} required missing · ${optionalMissing} optional missing`);
  return lines.join('\n');
}

export interface DependencyReportJson {
  platform: { environment: ProbeEnvironment };
  summary: { ok: number; requiredMissing: number; optionalMissing: number; exitCode: number };
  tools: ToolResult[];
}

export function renderJson(results: ToolResult[], environment: ProbeEnvironment): DependencyReportJson {
  const byStatus = (s: ToolStatus) => results.filter((r) => r.status === s).length;
  return {
    platform: { environment },
    summary: {
      ok: byStatus('ok'),
      requiredMissing: results.filter((r) => r.required && r.status !== 'ok' && r.status !== 'skipped').length,
      optionalMissing: results.filter((r) => !r.required && r.status === 'missing').length,
      exitCode: computeExitCode(results),
    },
    tools: results,
  };
}

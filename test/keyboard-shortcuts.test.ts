import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const appSource = readFileSync('src/web/public/app.js', 'utf8');
const helpHtml = readFileSync('src/web/public/index.html', 'utf8');
const readme = readFileSync('README.md', 'utf8');

describe('keyboard shortcuts', () => {
  it('uses physical Option+number keys so macOS special characters do not break tab switching', () => {
    expect(appSource).toContain('e.code ||');
    expect(appSource).toContain('Digit([1-9])');
    expect(appSource).toContain('parseInt(digitMatch[1], 10) - 1');
  });

  it('provides Option+bracket shortcuts for previous and next session', () => {
    expect(appSource).toContain("e.code === 'BracketLeft'");
    expect(appSource).toContain("e.code === 'BracketRight'");
    expect(appSource).toContain('this.prevSession()');
    expect(appSource).toContain('this.nextSession()');
  });

  it('documents mac-friendly Option shortcuts in help and README', () => {
    expect(helpHtml).toContain('<kbd>Option</kbd>+<kbd>[</kbd>');
    expect(helpHtml).toContain('<kbd>Option</kbd>+<kbd>]</kbd>');
    expect(helpHtml).toContain('<kbd>Option</kbd>+<kbd>1-9</kbd>');
    expect(readme).toContain('`Option+[` / `Option+]`');
    expect(readme).toContain('`Option+1`-`Option+9`');
  });
});

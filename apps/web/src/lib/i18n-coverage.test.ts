import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { translate } from './i18n';

/** Collects every English key passed to t('…') (including both branches of ternaries). */
function collectKeys(dir: string, out = new Map<string, string>()): Map<string, string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) collectKeys(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !name.includes('.test.') && name !== 'i18n.tsx') {
      const src = readFileSync(p, 'utf8');
      for (const start of src.matchAll(/\bt\(/g)) {
        // Find the matching ')' while skipping string contents.
        let i = start.index! + 2;
        let depth = 1;
        let quote: string | null = null;
        for (; i < src.length && depth; i++) {
          const c = src[i]!;
          if (quote) {
            if (c === '\\') i++;
            else if (c === quote) quote = null;
          } else if (c === "'" || c === '"' || c === '`') quote = c;
          else if (c === '(') depth++;
          else if (c === ')') depth--;
        }
        const body = src.slice(start.index! + 2, i - 1);
        const first = /^\s*'((?:[^'\\]|\\.)*)'/.exec(body);
        if (first) out.set(first[1]!.replace(/\\'/g, "'"), p);
        // Ternary branches: the operator is preceded by whitespace (a '?' inside a string is not).
        for (const m of body.matchAll(/\s[?:]\s+'((?:[^'\\]|\\.)*)'/g)) out.set(m[1]!.replace(/\\'/g, "'"), p);
      }
    }
  }
  return out;
}

describe('Arabic translations', () => {
  it('every literal UI string passed to t() has an Arabic translation', () => {
    const keys = collectKeys(join(__dirname, '..'));
    expect(keys.size).toBeGreaterThan(300);
    const missing = [...keys].filter(([k]) => /[a-z]/.test(k) && translate('ar', k) === k).map(([k, file]) => `${k}  (${file})`);
    expect(missing).toEqual([]);
  });
});

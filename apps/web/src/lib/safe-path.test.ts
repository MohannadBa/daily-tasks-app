import { describe, expect, it } from 'vitest';
import { isSafeInternalPath } from './safe-path';

describe('isSafeInternalPath (post-login redirect target)', () => {
  it('accepts same-site paths', () => {
    for (const p of ['/', '/tasks/123?tab=files', '/reviews#x']) expect(isSafeInternalPath(p)).toBe(true);
  });

  it('rejects external, protocol-relative and backslash-normalised targets', () => {
    const bad: unknown[] = ['https://evil.com', '//evil.com', '/\\evil.com', '/\\/evil.com', '\\\\evil.com', 'evil.com', '/tasks\\..\\x', '/a\nb', '', null, 42];
    for (const p of bad) expect(isSafeInternalPath(p)).toBe(false);
  });

  it('the browser really would turn "/\\evil.com" into another host (why backslashes are refused)', () => {
    expect(new URL('/\\evil.com', 'https://d123.cloudfront.net').host).toBe('evil.com');
  });
});

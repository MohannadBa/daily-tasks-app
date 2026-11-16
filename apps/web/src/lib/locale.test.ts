import { describe, expect, it } from 'vitest';
import { DEFAULT_LOCALE, resolveLocale } from './locale';

describe('resolveLocale', () => {
  it('Arabic is the default', () => {
    expect(DEFAULT_LOCALE).toBe('ar');
    expect(resolveLocale(undefined)).toBe('ar');
    expect(resolveLocale('xx')).toBe('ar');
  });
  it('a saved preference wins', () => {
    expect(resolveLocale('en')).toBe('en');
    expect(resolveLocale('ar')).toBe('ar');
  });
});

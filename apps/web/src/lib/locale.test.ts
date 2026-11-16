import { describe, expect, it } from 'vitest';
import { resolveLocale } from './locale';

describe('resolveLocale', () => {
  it('prefers the saved cookie', () => {
    expect(resolveLocale('ar', 'en-US,en;q=0.9')).toBe('ar');
    expect(resolveLocale('en', 'ar-SA')).toBe('en');
  });
  it('falls back to the best supported Accept-Language', () => {
    expect(resolveLocale(undefined, 'ar-SA,ar;q=0.9,en;q=0.8')).toBe('ar');
    expect(resolveLocale(undefined, 'fr-FR,en;q=0.5,ar;q=0.9')).toBe('ar');
    expect(resolveLocale(undefined, 'fr-FR,de;q=0.9')).toBe('en');
  });
  it('defaults to English', () => {
    expect(resolveLocale(undefined, null)).toBe('en');
    expect(resolveLocale('xx', '')).toBe('en');
  });
});

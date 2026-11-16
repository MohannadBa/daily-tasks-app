import { describe, expect, it } from 'vitest';
import { translate } from './i18n';

describe('translate', () => {
  it('returns Arabic strings with interpolation', () => {
    expect(translate('ar', 'Dashboard')).toBe('لوحة التحكم');
    expect(translate('ar', 'Welcome, {name}', { name: 'منى' })).toBe('مرحباً، منى');
  });
  it('falls back to the English key', () => {
    expect(translate('en', 'Welcome, {name}', { name: 'Mona' })).toBe('Welcome, Mona');
    expect(translate('ar', 'Some untranslated text')).toBe('Some untranslated text');
  });
});

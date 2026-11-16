export type Locale = 'en' | 'ar';

/** Arabic is the application's default language; English is available as a full secondary language. */
export const DEFAULT_LOCALE: Locale = 'ar';

/** Picks the UI language: the saved `dt_locale` cookie if valid, otherwise Arabic. Pure (server and tests). */
export function resolveLocale(cookieValue: string | undefined): Locale {
  return cookieValue === 'en' || cookieValue === 'ar' ? cookieValue : DEFAULT_LOCALE;
}

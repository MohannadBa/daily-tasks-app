export type Locale = 'en' | 'ar';

/**
 * Picks the UI language: the saved `dt_locale` cookie if present, otherwise the first supported
 * language in the Accept-Language header, otherwise English. Pure (server and tests).
 */
export function resolveLocale(cookieValue: string | undefined, acceptLanguage: string | null | undefined): Locale {
  if (cookieValue === 'ar' || cookieValue === 'en') return cookieValue;
  const ranked = (acceptLanguage ?? '')
    .split(',')
    .map((part) => {
      const [tag, ...params] = part.trim().toLowerCase().split(';');
      const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
      return { tag, q: q ? Number(q.slice(2)) || 0 : 1 };
    })
    .filter((x) => x.tag)
    .sort((a, b) => b.q - a.q);
  for (const { tag } of ranked) {
    if (tag === 'ar' || tag.startsWith('ar-')) return 'ar';
    if (tag === 'en' || tag.startsWith('en-')) return 'en';
  }
  return 'en';
}

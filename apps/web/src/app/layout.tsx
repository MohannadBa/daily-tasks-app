import type { Metadata, Viewport } from 'next';
import { IBM_Plex_Sans_Arabic } from 'next/font/google';
import { cookies } from 'next/headers';
import type { ReactNode } from 'react';
import { Providers } from '@/components/providers';
import { resolveLocale } from '@/lib/locale';
import './globals.css';

// Arabic-first typeface with matching Latin glyphs (self-hosted by next/font at build time).
const plex = IBM_Plex_Sans_Arabic({ subsets: ['arabic', 'latin'], weight: ['400', '500', '600', '700'], display: 'swap', variable: '--font-plex-arabic' });

const BRAND = { ar: { name: 'الراسيات', product: 'الراسيات — إدارة المهام' }, en: { name: 'Al-Rasiyat', product: 'Al-Rasiyat — Task Management' } };

export async function generateMetadata(): Promise<Metadata> {
  const locale = resolveLocale((await cookies()).get('dt_locale')?.value);
  const b = BRAND[locale];
  return {
    applicationName: b.name,
    title: { default: b.product, template: `%s · ${b.name}` },
    description: locale === 'ar' ? 'منصة إدارة المهام لشركة الراسيات' : 'Al-Rasiyat company task management',
    // iOS Home Screen: standalone launch, app title under the icon, status bar style.
    appleWebApp: { capable: true, title: BRAND.ar.name, statusBarStyle: 'default' },
    formatDetection: { telephone: false, email: false, address: false },
    icons: {
      icon: [
        { url: '/icon.svg', type: 'image/svg+xml' },
        { url: '/favicon-32.png', sizes: '32x32', type: 'image/png' },
      ],
      apple: [{ url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
    },
    // Next 15 emits only `mobile-web-app-capable`; older iOS versions read the apple- prefixed tag.
    other: { 'apple-mobile-web-app-capable': 'yes' },
  };
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Draw under the notch / home indicator; the shell pads itself with env(safe-area-inset-*).
  viewportFit: 'cover',
  themeColor: '#c0903d',
  colorScheme: 'light',
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Arabic is the default; a saved choice (dt_locale cookie) wins.
  const locale = resolveLocale((await cookies()).get('dt_locale')?.value);
  return (
    <html lang={locale} dir={locale === 'ar' ? 'rtl' : 'ltr'} className={plex.variable}>
      <body className="antialiased">
        <Providers locale={locale}>{children}</Providers>
      </body>
    </html>
  );
}

import type { Metadata, Viewport } from 'next';
import { cookies, headers } from 'next/headers';
import type { ReactNode } from 'react';
import { Providers } from '@/components/providers';
import { resolveLocale } from '@/lib/locale';
import './globals.css';

export const metadata: Metadata = {
  applicationName: 'DailyTasks',
  title: { default: 'DailyTasks', template: '%s · DailyTasks' },
  description: 'Company task management',
  // iOS Home Screen: standalone launch, app title under the icon, status bar style.
  appleWebApp: { capable: true, title: 'DailyTasks', statusBarStyle: 'default' },
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

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Draw under the notch / home indicator; the shell pads itself with env(safe-area-inset-*).
  viewportFit: 'cover',
  themeColor: '#ffffff',
  colorScheme: 'light',
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Saved choice wins; otherwise the device language (first launch of an installed app has no cookie yet).
  const locale = resolveLocale((await cookies()).get('dt_locale')?.value, (await headers()).get('accept-language'));
  return (
    <html lang={locale} dir={locale === 'ar' ? 'rtl' : 'ltr'}>
      <body className="antialiased">
        <Providers locale={locale}>{children}</Providers>
      </body>
    </html>
  );
}

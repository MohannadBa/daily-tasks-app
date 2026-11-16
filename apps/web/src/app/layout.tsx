import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import type { ReactNode } from 'react';
import { Providers } from '@/components/providers';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'DailyTasks', template: '%s · DailyTasks' },
  description: 'Company task management portal',
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = (await cookies()).get('dt_locale')?.value === 'ar' ? 'ar' : 'en';
  return (
    <html lang={locale} dir={locale === 'ar' ? 'rtl' : 'ltr'}>
      <body className="antialiased">
        <Providers locale={locale}>{children}</Providers>
      </body>
    </html>
  );
}

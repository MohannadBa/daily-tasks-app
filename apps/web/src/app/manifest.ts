import type { MetadataRoute } from 'next';

/** Web App Manifest, served at /manifest.webmanifest (Next links it from every page automatically). */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/',
    // Arabic-first product name; English: "Al-Rasiyat — Task Management".
    name: 'الراسيات — إدارة المهام',
    short_name: 'الراسيات',
    description: 'إدارة مهام شركة الراسيات: الإسناد والردود والملفات والمواعيد النهائية.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    display_override: ['standalone', 'minimal-ui'],
    orientation: 'any',
    // Brand tokens (app/globals.css): canvas + logo gold.
    background_color: '#f7f6f3',
    theme_color: '#c0903d',
    lang: 'ar',
    dir: 'rtl',
    categories: ['productivity', 'business'],
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    shortcuts: [
      { name: 'مهامي', short_name: 'المهام', url: '/tasks?view=active', icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }] },
      { name: 'الإشعارات', url: '/notifications', icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }] },
    ],
  };
}

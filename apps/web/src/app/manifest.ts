import type { MetadataRoute } from 'next';

/** Web App Manifest, served at /manifest.webmanifest (Next links it from every page automatically). */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/',
    name: 'DailyTasks',
    short_name: 'DailyTasks',
    description: 'Company task management: assignments, replies, files and deadlines.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    display_override: ['standalone', 'minimal-ui'],
    orientation: 'any',
    background_color: '#f6f8fb',
    theme_color: '#ffffff',
    lang: 'en',
    dir: 'auto',
    categories: ['productivity', 'business'],
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    shortcuts: [
      { name: 'My tasks', short_name: 'Tasks', url: '/tasks?view=active', icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }] },
      { name: 'Notifications', url: '/notifications', icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }] },
    ],
  };
}

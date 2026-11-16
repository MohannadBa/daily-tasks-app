import path from 'node:path';
import type { NextConfig } from 'next';

const config: NextConfig = {
  output: 'standalone',
  // Monorepo: trace dependencies from the repository root so the standalone build is complete.
  outputFileTracingRoot: path.join(__dirname, '../../'),
  poweredByHeader: false,
  // Linting runs separately via `pnpm lint`.
  eslint: { ignoreDuringBuilds: true },
  reactStrictMode: true,
  // Next 15 streams metadata into <body> on dynamic pages. Browsers only honour the manifest link,
  // apple-touch-icon and apple-mobile-web-app-* tags in <head>, so render metadata blocking for every UA.
  htmlLimitedBots: /.*/,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
      {
        // The service worker must always be revalidated so updates roll out on the next launch.
        source: '/sw.js',
        headers: [
          { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
          { key: 'Content-Type', value: 'application/javascript; charset=utf-8' },
          { key: 'Service-Worker-Allowed', value: '/' },
        ],
      },
      {
        source: '/offline.html',
        headers: [{ key: 'Cache-Control', value: 'no-cache' }],
      },
    ];
  },
};

export default config;

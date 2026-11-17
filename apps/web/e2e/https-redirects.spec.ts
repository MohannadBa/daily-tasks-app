import { expect, test } from '@playwright/test';

/**
 * Behind CloudFront (HTTPS-only) → VPC origin → ALB the app receives plain-http requests. Any
 * absolute http:// redirect would be rejected by CloudFront with 403, so the real server must emit
 * RELATIVE Location headers for its redirects. These requests mimic what the ALB forwards.
 */
const behindCloudFront = {
  Host: 'd123abc.cloudfront.net',
  'X-Forwarded-Proto': 'http',
  'X-Forwarded-For': '198.51.100.7, 10.0.3.25',
};

test('signed-out redirect to /login uses a relative Location (stays on https behind CloudFront)', async ({ request }) => {
  for (const headers of [{}, behindCloudFront]) {
    const res = await request.get('/tasks?view=overdue', { maxRedirects: 0, headers });
    expect(res.status()).toBe(307);
    const location = res.headers()['location'];
    expect(location).toBe('/login?next=%2Ftasks%3Fview%3Doverdue');
    expect(location).not.toMatch(/^https?:/);
  }
});

test('signed-out root redirect is relative too', async ({ request }) => {
  const res = await request.get('/', { maxRedirects: 0, headers: behindCloudFront });
  expect(res.status()).toBe(307);
  expect(res.headers()['location']).toBe('/login');
});

# Security & production-readiness audit

Date: 2026-11-16. Scope: API, worker, web/PWA, service worker, Web Push, Docker, AWS CDK. Method: code review plus automated tests (see "Evidence"). This is an internal engineering review, not a third-party penetration test.

## Findings fixed in this audit

| # | Finding | Severity | Fix | Evidence |
|---|---|---|---|---|
| 1 | Production could be deployed **without HTTPS** (certificate optional). Phones would get no service worker, no install, no push and non-Secure cookies. | High | Production synth now **fails** without a certificate (or domain + hosted zone) and an `https://` public URL; staging warns. | CDK tests "HTTPS and custom domain" |
| 2 | **Shared login throttle:** the web BFF called the API without the client IP, so the API's per-IP limits (10 logins/min) applied to *all users together* (the web task's IP) and would lock everyone out at peak times. | High (availability) | BFF and session routes forward the last `X-Forwarded-For` hop (the one the ALB appended; client-supplied hops ignored). The API trusts exactly one hop. | `client-ip.test.ts`; manual: 11 logins from 11 IPs all 200, 11 from one IP → 11th 429 |
| 3 | No custom-domain automation (manual DNS/cert). | Medium | Optional `domainName` + hosted zone → Route 53 alias + DNS-validated ACM certificate; HTTP→HTTPS redirect. | CDK tests |
| 4 | Worker container ran Node as PID 1 without an init (comment claimed tini). | Low | `ENTRYPOINT ["/usr/bin/tini","--"]` | `docker compose exec worker cat /proc/1/cmdline`; stop → exit 0 |
| 5 | No HSTS header. | Low | `Strict-Transport-Security: max-age=31536000` (ignored by browsers over plain HTTP) | HTTPS check |
| 6 | Requested `VAPID_*` variable names not accepted. | Low | Aliases for `WEB_PUSH_*`. | worker test "VAPID env aliases" |

## Findings fixed in the production-readiness release (Al-Rasiyat)

| # | Finding | Severity | Fix |
|---|---|---|---|
| 7 | Dependency audit: 45 advisories (4 critical, 22 high) in Next.js 15.5.4, postcss, sharp, deepmerge-ts, Playwright | Critical | Next.js 15.5.29, Playwright 1.55.1, pnpm overrides postcss ^8.5.33, sharp ^0.35.5, deepmerge-ts ^8. `pnpm audit --prod`: 1 remaining (see accepted risk) |
| 8 | WebSocket upgrades to unknown paths were left open (socket/resource leak) | Medium | Rejected with 404 |
| 9 | New real-time channel | — | Cookie/Bearer auth + active-user check, Origin allow-list (CSWSH), per-user socket cap, token-expiry close, ids-only payloads, per-user delivery (tests in `platform.e2e-spec.ts`) |
| 10 | Password recovery | — | No account enumeration (always 202), 5/min throttle, Cognito-only; local mode returns 501 instead of a fake reset |

**Accepted risk:** `zod` < 4.6.6, GHSA-mrhx-c7xc-m3w5 (memory exhaustion validating oversized constrained collections). No 3.x fix exists. Mitigation: request bodies are capped at 100 KB by the API's JSON parser, so input size is bounded. Follow-up: migrate `packages/validation`, `packages/config` and the API to zod 4.

## Checks with no finding

| Area | Result |
|---|---|
| **Authentication** | Cognito access tokens verified (signature, issuer, expiry, `token_use`, client id); user row reloaded per request (deactivation immediate); tokens only in httpOnly cookies (`Secure` + `SameSite=Lax` over HTTPS, verified in Chrome); `AUTH_MODE=local` refused in production; login throttled per client. |
| **Project authorization** | All project/task access goes through `AccessService`; foreign resources → 404; membership removal immediate (API tests 1–3, 15). |
| **Rating privacy** | Rating routes restricted to admins/managers *and* task-manager access; employee DTOs never contain ratings; rating audit separate from employee-visible history (API tests 4–8, 14). No notification type carries rating data. |
| **Push subscription ownership** | Owner is always the authenticated user (body `userId` ignored); unsubscribe/status limited to own rows; endpoint/p256dh/auth never returned or logged (only `endpointHash` and host); sign-out removes the device; endpoint host allow-list prevents SSRF (API push e2e + worker tests). |
| **VAPID key security** | Private key only in the worker, via Secrets Manager → ECS secret (CDK test asserts it is absent from the API); never in DB/images/logs; production refuses the committed development key. Public key is public by design. |
| **Private attachments** | S3 bucket blocks public access, TLS-only, SSE; uploads/downloads only via short-lived pre-signed URLs issued after `AccessService` checks; content type + size are signed (API attachment tests). |
| **API CORS** | `CORS_ORIGINS` = the app's own https origin; browsers use the same-origin BFF, cross-origin mutations to the BFF are rejected (403, verified). S3 CORS pinned to the app origin. |
| **Service-worker caching** | Never caches pages (HTML), `/bff/*`, `/session/*` or cross-origin (S3) responses; RSC fetches are not intercepted; only content-hashed `/_next/static/*` and public icons/manifest/offline page are cached. Nothing user-specific survives sign-out (`sw.test.ts`, PWA docs). |
| **Notification payload privacy** | Payload is end-to-end encrypted (aes128gcm) to the device; push services cannot read it. Contents = title + body as in the in-app list (task title, project, actor name), ids and the in-app path. Never ratings, feedback, comment text or attachments. Note: task titles can appear on a **locked screen**, so avoid confidential data in task titles (or set iOS/Android previews to "when unlocked"). |
| **Secrets exposure** | `git ls-files` contains no `.env`, keys or certificates (only `.env.example`). Env validation errors list keys only. No token/password/secret logging found. The development VAPID pair and `JWT_SECRET` default in `docker-compose.yml` are local-only by design and rejected in production. |
| **Docker** | Multi-stage builds, prod-only deps, non-root `node` user, `tini`, HEALTHCHECKs; graceful shutdown verified (worker exit 0 after draining, api 1.2 s, web exit 0); Postgres data on a named volume; dev/test/production separated by `NODE_ENV` guards. |

## Recommendations (not blocking)
* **Content-Security-Policy:** not set yet. Next.js needs a nonce-based CSP for a strict policy; add once the S3 upload host per environment is fixed (`connect-src`).
* **AWS WAF** on the ALB (managed rule sets, rate-based rule): about $10–20/month.
* **ALB access logs** to S3 for incident forensics.
* **RDS TLS verification:** `sslmode=require` encrypts but does not verify the server certificate; bundle the RDS CA and use `verify-full`.
* **Third-party penetration test** before handling sensitive data at scale.

## Evidence (automated, 2026-11-16, production-readiness release)
`pnpm typecheck` (9 packages) ✓ · `pnpm lint` ✓ · `pnpm test` **160 passed** (API 56, worker 40, web 34, validation 17, CDK 13) · web production build ✓ · images built ✓ · `pnpm test:docker` **17/17** · Playwright browser E2E **15/15**.

## Evidence (automated, 2026-11-16, earlier audit)
`pnpm typecheck` (9 packages) ✓ · `pnpm lint` ✓ · `pnpm test`: API 46, worker 34, web 25, validation 17, CDK 13 (**135 passed**) · web production build ✓ · `docker compose config` ✓ · images built ✓ · `pnpm test:docker` **17/17** · HTTPS production-like check (TLS proxy + Secure-cookie web container + Chrome on `https://dailytasks.test`) **13/13**, incl. real FCM push displayed · desktop Chrome real FCM delivery (localhost) ✓.

**Not done (requires people with devices):** physical iPhone/Android verification. See docs/REAL_DEVICE_TESTS.md.

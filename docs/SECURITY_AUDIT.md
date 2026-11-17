# Security & production-readiness audit

Date: 2026-11-16. Scope: API, worker, web/PWA, service worker, Web Push, Docker, AWS CDK. Method: code review plus automated tests (see "Evidence"). This is an internal engineering review, not a third-party penetration test.

## Production-first review (2026-11-17, staging skipped)

Scope: changes needed to make the first production deployment the acceptance environment. Verified offline (CDK synth/tests with credentials blanked, API/worker suites, local TLS proof); nothing deployed.

| # | Change | Why | Evidence |
|---|---|---|---|
| P1 | **Restricted acceptance mode** (`ACCESS_MODE=restricted`, production default): only allow-listed e-mails can sign in, refresh, use the API/socket or be provisioned; others get the generic 401 | First production deploy must not be usable by ordinary employees | `access-mode.e2e-spec.ts` (5), Cognito contract test, CDK tests |
| P2 | **SES** for Cognito e-mail (separate `DailyTasks-Mail` stack, DKIM, custom MAIL FROM); required by the CDK in production | Default sender limits / deliverability; DKIM-signed company sender | CDK tests |
| P3 | **AWS WAF**: IP reputation, known bad inputs, core rule set, sign-in rate limit 200/5 min/IP, global 6000/5 min/IP, optional IP allow-list; logs redact `Authorization`/`Cookie` | Shared rate limiting across API tasks; edge filtering | CDK tests |
| P4 | Production **retention**: log groups, user pool (deletion protection), buckets, DB credentials secret retained; DB snapshot on delete; termination protection | Production-first means no environment can be thrown away | CDK tests, synth |
| P5 | ALB access logs (private, SSE-S3, 90 d); 5 new alarms (unhealthy targets, DB memory/connections, WAF sign-in blocks) | Incident evidence and detection | CDK tests |
| P6 | **DB TLS proven**: in the real API image, the RDS CA bundle refuses a non-RDS certificate and a wrong host name; scripted positive + negative check for production (`db-tls-check`) | Previous review could only assert the configuration | PRODUCTION_PLAN.md §7.2 |
| P7 | **Restore verification**: read-only `verify-restore` (migrations, counts, every personal task decrypts) + scripted drill; `DB_HOST_OVERRIDE` limited to RDS endpoints; drill target guarded in the script and in the verifier (R3) so a drill can never read production | Backups are only proven by restoring them, together with the key | `verify-restore.test.ts`, `db-url.spec.ts` |
| P8 | Corrected secret names in the docs/scripts (`dailytasks-<env>/…`) | The key-escrow command in earlier docs would have failed | grep of docs/scripts |
| P10 | Cross-region backups: RDS automated backups replicated to eu-west-1 (14 days) under a customer-managed key that is retained, rotated, usable by RDS only via the service, and cannot be disabled or scheduled for deletion without a deliberate key-policy change; automated backups kept after instance deletion; manual snapshots copied to Ireland; isolated (no ingress/egress, no internet) restore-drill network | Regional resilience and backup durability (R5) | CDK tests (5), offline synth, script dry runs incl. failure paths |
| P9 | Deploy script safety: region pin (eu-north-1, checked in `.env` and in the CLI's resolved region; CDK refuses other regions), account check, typed stack name for every change, `OPEN ACCESS` phrase to open, automatic pre-migration snapshot, no destroy command | Human error during a production-first rollout | dry runs with a stubbed AWS CLI |

Residual risks: per-IP API sign-in limits (10/min per task) may throttle a morning rush behind one office IP — monitor at opening; WAF CRS rules `SizeRestrictions_BODY`/`CrossSiteScripting_BODY` are COUNT-only; SES sandbox until production access; Cognito threat protection (Plus tier) not enabled; real Cognito, devices, RDS TLS and restore still to be executed (PRODUCTION_PLAN.md §8).

## Final staging-readiness security review (2026-11-17)

Method: code review of every area below, the synthesized staging template (`cdk synth --no-lookups`, no AWS calls), and the automated suites. Real Cognito, real AWS IAM evaluation and physical devices are **not** covered and are listed as open items.

### Findings fixed in this review
| # | Finding | Severity | Fix | Evidence |
|---|---|---|---|---|
| S1 | Admin password reset (Cognito) did not revoke existing sessions — a stolen refresh token (30 days) kept working after the user chose a new password | High | Every admin reset calls `AdminUserGlobalSignOut`; old access tokens are gated by `mustChangePassword` until expiry | `identity.cognito.spec.ts`; staging script C7 |
| S2 | Completing an e-mailed reset code left `mustChangePassword` set → user forced to change the password twice | Medium (availability/UX) | `confirmPasswordReset` clears the flag + audits `via: reset-code` | `identity.cognito.spec.ts`; staging step M5 |
| S3 | Database TLS was `sslmode=require` without certificate verification (MITM possible inside the network path) | Medium | Public RDS CA bundle baked into api/worker images; `DB_SSL_CA_FILE` → Prisma `sslcert` + `sslaccept=strict`; set by CDK for api, worker and migrate | `db-url.spec.ts`, CDK test; **first proof = staging migrate** |
| S4 | No way to rotate the personal-data encryption key without losing personal tasks | Medium | Key ring (current + previous), lazy re-encryption on read, `rekey-personal` one-off task, CDK `personalDataKeyPreviousSecretArn`, runbook | `personal-cipher.test.ts`, API rotation e2e test, OPERATIONS.md §8 |
| S5 | API task role could delete any S3 object (not needed) | Low | API role: read + put only; deletes remain worker-only | CDK least-privilege test |
| S6 | First admin of an environment required hand-written SQL in production | Low (operational risk) | `bootstrap-admin` one-off task (idempotent, refuses if an admin exists, no password stored) | `bootstrap-admin.test.ts` |

### Area-by-area results
| Area | Result | Notes |
|---|---|---|
| Authentication & Cognito integration | ✅ code / ⏳ real Cognito | USER_PASSWORD_AUTH on a public client; JWKS verification (token_use=access, client_id); generic errors; `preventUserExistenceErrors`; S1/S2 fixed. Real pool behaviour unverified — COGNITO_TESTS.md |
| Temporary password provisioning | ✅ | CSPRNG 16 chars; EMAIL (Cognito never exposes it to us) or SHOW_ONCE (returned once; never in DB/logs/audit/browser storage — browser test) |
| Forced first-login change | ✅ | Login challenge + API gate `PASSWORD_CHANGE_REQUIRED` + blocking web screen |
| Global sign-out | ✅ code / ⏳ Cognito | On deactivation and (new) on admin reset; DB `isActive` re-checked every request |
| Role & project authorization | ✅ | Centralised in AccessService; IDOR-safe 404; creator/approver task scope (managers don't see each other's tasks; admin has no company-wide task access); 91+ API tests |
| Department restrictions | ✅ | Assignee/transfer target must be in project ∩ department; inactive departments refused |
| Personal task encryption | ✅ | AES-256-GCM, owner id as AAD, owner-only for every role; key only in the api container |
| Encryption-key backup & recovery | ⚠️ process | Secret RETAINed; **escrow procedure must be executed by a human after the first deploy** (OPERATIONS.md §8) |
| Encryption-key rotation | ✅ | S4 |
| Approval & transfer authorization | ✅ | Approver/admin-with-reason only; no self-approval along the chain; conditional claims (409 on races); chain depth ≤ 3, no cycles |
| Rating privacy | ✅ | Only the task's managers; never the assignee (incl. admins who are assignees); excluded from employee DTOs, dashboards, reports |
| Document permissions | ✅ | Project membership + visibility; task deliverables "managers only" limited to the task's managers; pre-signed URLs only after checks |
| S3 access | ✅ | Private bucket, Block Public Access, TLS-only policy, SSE, CORS pinned to the domain; random object keys; type+size signed uploads; HeadObject confirm; inline disposition only for images/PDF |
| PDF report access | ✅ | Private to the requester; dataset authorized at request time and deleted after rendering; 20/hour quota; 7-day retention + S3 lifecycle |
| WebSocket authentication | ✅ | httpOnly cookie or bearer; Origin check; inactive users refused; 4401 on expiry; ids-only payloads |
| Web Push subscription ownership | ✅ | All subscription queries scoped to the caller; endpoint allow-list (SSRF); keys never returned or logged |
| VAPID private key | ✅ | Secrets Manager → worker only; dev key refused in production |
| Secrets Manager permissions | ✅ | Each execution role can read only its own container's secrets; web has none |
| Database TLS | ✅ after S3 / ⏳ staging | Verified-TLS path must be proven on the first staging migrate |
| Trusted proxy configuration | ✅ | ALB appends the client IP; the BFF forwards only the last X-Forwarded-For entry; the API trusts exactly one hop |
| Rate limiting | ✅ / ⚠️ | Login/new-password/forgot/reset/refresh/push-test throttled per IP; **in-memory per API task** (effective limit × task count in production) — recommend an AWS WAF rate-based rule for `/api/v1/auth/*` |
| Logging & redaction | ✅ | Only error names/ids/hosts logged; env validation lists keys only; no tokens, passwords, keys, subscription secrets or personal content |

### Open items (cannot be closed without staging / people)
1. Real Cognito behaviour (COGNITO_TESTS.md C0–C9, M1–M8).
2. Verified DB TLS on RDS (first staging migrate).
3. Personal-data key escrow by two custodians.
4. Production e-mail via SES (Cognito default sender limits).
5. Physical-device push tests (REAL_DEVICE_TESTS.md).
6. Recommended: WAF rate-based rule, ALB access logs, CloudTrail, RDS credential rotation, a restore drill.

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

## Task visibility tightened (creator/approver + assignee)
* Requirement: managers must not see other managers' tasks; the system admin must not see every task. Implemented centrally (`managedTaskScope`, `managesTask`, `canSeeRating` in AccessService) and applied to task lists/detail/actions, dashboards (totals, workload, awaiting rating), ratings & performance, report datasets, Documents Center (task deliverables kept "managers only"), project task counters, outbox recipients (deliverables) and worker notifications (comments, completion, overdue → creator + approver only). Admin "all approvals" inbox removed.
* Self-protection: nobody can be the assignee of a task they create or approve; an admin who is an assignee never sees his own rating or performance figures.
* Tests: API `task visibility: creator/approver + assignee only` (2 scenarios), updated authorization tests, worker fan-out tests.

## Enterprise platform (backend + frontend) security verification
* **Authorization stays server-side.** Every new screen only hides actions using server-computed `permissions`; each endpoint re-checks (AccessService, 404 for resources outside the caller's scope). Tested: approver-only decisions, no self-approval (chain members), delegator-only forward/return, recipient-only transfer accept/decline, approver/admin-only extension decisions, managers-only document upload/archive, `MANAGERS_ONLY` documents hidden from employees (UI + API 404).
* **Ratings:** review inbox, dashboards (workload), reports for employees and every task DTO used by new screens exclude rating data; reports include ratings only when the API decided `includesRatings` (admins / managers of all included projects).
* **Personal tasks:** owner-only for every role including ADMIN (404), AES-256-GCM with the owner id as AAD; never in tasks, dashboards (company KPIs), reports, documents or notifications. Browser test verifies other roles never receive them.
* **Temporary passwords:** generated with a CSPRNG, stored only as bcrypt (local) or in Cognito, returned once in the create/reset response, kept only in React state on the Administration page (browser test asserts it is not in localStorage/sessionStorage/cookies), never logged or audited. `mustChangePassword` blocks every API route except `/auth/me` and `/auth/change-password`; the web app shows a blocking change-password screen.
* **Document preview:** inline disposition only for images/PDF (no HTML/SVG inline → no stored XSS via S3); everything else downloads.
* **Notifications / WebSocket:** new event payloads carry ids, types and short reasons only; WebSocket events remain ids/types and trigger refetches.
* **Concurrency:** decisions are conditional claims → duplicate approvals/rejections get 409, never double effects.

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

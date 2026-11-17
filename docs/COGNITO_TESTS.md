# Cognito verification plan & record

**Status: NOT VERIFIED against real Cognito.** Nothing has been deployed. Staging was skipped: these tests now run on **production in restricted acceptance mode** ([PRODUCTION_PLAN.md](PRODUCTION_PLAN.md) §7.1), where Cognito sends e-mail through **SES** from the company domain.
Everything below marked "local" or "contract" was run without Cognito. Real verification requires the
staging deployment ([STAGING_PLAN.md](STAGING_PLAN.md)) and is recorded in the table at the end.

## What has been verified so far (and what that does *not* prove)

| Layer | Evidence | Proves | Does **not** prove |
|---|---|---|---|
| Local auth mode (API integration tests, Playwright, smoke) | `apps/api/test/*.e2e-spec.ts`, `apps/web/e2e/enterprise.spec.ts` | Our own flows: temp password shown once & hashed, first-login challenge, forced change gate (`PASSWORD_CHANGE_REQUIRED`), deactivation, admin-only provisioning, audit without secrets | Anything Cognito does |
| Cognito **contract** tests (stubbed SDK client) | `apps/api/src/auth/identity.cognito.spec.ts` (12 tests) | Which Cognito APIs we call with which parameters (AdminCreateUser EMAIL vs SUPPRESS, NEW_PASSWORD_REQUIRED mapping, AdminSetUserPassword `Permanent=false`, AdminUserGlobalSignOut, AdminDisableUser, ConfirmForgotPassword clears the flag), generic errors, no account enumeration | E-mail delivery, Cognito password policy, token revocation, real error names, latency |
| CDK assertions | `infrastructure/aws-cdk/test` | Pool config: no self sign-up, `preventUserExistenceErrors`, token revocation, IAM allows exactly the admin APIs used | That the deployed pool behaves accordingly |

## Production Cognito flows (implementation summary)
* **Sign-in** — `USER_PASSWORD_AUTH` on a public app client (no secret). Unknown/inactive users are refused before Cognito is called; all failures return the same 401.
* **Admin creates an account** — `AdminCreateUser`. Default delivery **EMAIL**: Cognito generates and e-mails the temporary password (our system never sees it). Optional **SHOW_ONCE**: we generate it (CSPRNG, 16 chars), suppress the e-mail, return it once.
* **First login** — Cognito returns `NEW_PASSWORD_REQUIRED`; the web app shows the "choose your own password" step; `RespondToAuthChallenge` completes it; our `mustChangePassword` flag is cleared and audited.
* **Forced change gate** — while `mustChangePassword` is set, every API route except `/auth/me` and `/auth/change-password` returns 403 `PASSWORD_CHANGE_REQUIRED`; the web app shows a blocking screen.
* **Password reset** — self-service: `ForgotPassword` + `ConfirmForgotPassword` (e-mailed code); admin: EMAIL (`AdminResetUserPassword`, user then uses "Forgot password" with the code) or SHOW_ONCE (`AdminSetUserPassword Permanent=false`). **Fixed in this review:** completing an e-mailed code now clears `mustChangePassword` (users were otherwise forced to change twice), and every admin reset now calls `AdminUserGlobalSignOut` (stolen refresh tokens stop working).
* **Global sign-out / deactivation** — `AdminDisableUser` + `AdminUserGlobalSignOut`; refresh tokens are revoked by Cognito. Access tokens are verified locally (JWKS) and stay cryptographically valid until expiry (≤ 1 h), therefore the API **also** re-reads `isActive` / `mustChangePassword` from the database on every request — a deactivated user is refused immediately.

## Automated staging test (run after the staging deploy)
`scripts/cognito-staging-test.mjs` — talks only to the staging API over HTTPS; creates one QA account and deactivates it at the end; never prints passwords or tokens.
```bash
STAGING_URL=https://<staging-domain> ADMIN_EMAIL=<bootstrap admin> ADMIN_PASSWORD=<…> \
TEST_EMAIL_DOMAIN=<a domain you control> node scripts/cognito-staging-test.mjs
```
| ID | Flow |
|---|---|
| C0 | Admin signs in through Cognito; `/auth/me` role ADMIN |
| C1 | Admin creates an employee (SHOW_ONCE); temp password returned once, never again |
| C2 | Login with the temp password → `NEW_PASSWORD_REQUIRED`, no tokens |
| C3 | Wrong password → generic 401 |
| C4 | Weak new password refused by the Cognito policy; valid one completes the challenge, flag cleared |
| C5 | Temp password dead; normal login works; Cognito token accepted by the API |
| C6 | Authenticated password change (`ChangePassword`); old password rejected |
| C7 | Admin reset → refresh token revoked (global sign-out), old access token refused or gated, new password forced |
| C8 | Deactivation → access token refused at once, refresh revoked, login refused |
| C9 | Forgot-password response identical for unknown and known accounts |

### Restricted acceptance mode
The test account must be allow-listed: run with `TEST_EMAIL=<allow-listed, not yet existing address>` (e.g. `qa-cognito-1@<domain>`); each run deactivates it, so use a new allow-listed address per run. Extra checks: **R1** admin creating a non-allow-listed account → 403 "restricted acceptance mode"; **R2** a non-allow-listed address cannot sign in (same generic error as a wrong password). Covered locally by `apps/api/test/access-mode.e2e-spec.ts` and a Cognito contract test (refused before Cognito is called).

## Manual steps (need a real mailbox)
| ID | Step | Expected |
|---|---|---|
| M1 | Administration → New account, leave temporary password empty (EMAIL delivery) for a mailbox you can read | Bilingual invitation e-mail arrives (subject "حسابك في الراسيات · Your Al-Rasiyat account") with user name + temporary password; check spam folder; note sender address |
| M2 | Sign in with the e-mailed temporary password | "Welcome! Choose your own password" step; after saving, dashboard opens |
| M3 | Sign out; sign in with the new password | Signed in normally |
| M4 | Administration → Reset password (EMAIL delivery) | Reset code e-mail arrives; signing in with the old password fails |
| M5 | "Forgot password?" → enter e-mail → enter code + new password | Password set; sign-in works; **no second forced change** (fix verified) |
| M6 | Expired temporary password (temp validity 7 days — test by asking Cognito support or skip) | Login refused; admin must reset |
| M7 | Deactivate the account while it is signed in on a phone | Next action on the phone → signed out |
| M8 | Check sender + authentication of the invitation (mail client "show original"). *During acceptance without a domain the sender is Cognito's default `no-reply@verificationemail.com` (≈50/day, may land in spam) — repeat M8 after SES is connected* | From `SES_FROM_ADDRESS`; DKIM=pass, SPF=pass for `ses-bounce.<domain>`; not in spam. While SES is in the sandbox only verified identities receive mail |

## Record (fill in on staging — do not pre-fill)
| Date | Environment | Tester | C0–C9 result | M1–M8 result | Notes |
|---|---|---|---|---|---|
| | production (restricted) | | NOT RUN | NOT RUN | R1–R2: NOT RUN |

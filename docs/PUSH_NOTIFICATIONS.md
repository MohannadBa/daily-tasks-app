# Push notifications (Web Push)

Browser push for the installed PWA on iPhone/iPad (iOS 16.4+, Home Screen app only) and Android (Chrome-based browsers), plus desktop browsers. Standard **Web Push API + service worker + VAPID**; no native app, no Expo, no FCM SDK. Push services (Apple, Google, Mozilla, Microsoft) decide when a device actually receives a message, so **delivery time is not guaranteed**. A `2xx` from the push service means "accepted", not "displayed".

## Flow (one pipeline, no second notification system)

```
API (business change) ──$transaction──► OutboxEvent ──relay──► SQS ──► worker EventProcessor
                                                                          │
   Notifier.notify():                                                     ▼
   1. Notification rows (history)       unique (userId, dedupeKey)  ← stored BEFORE any push
   2. PushDelivery rows                 unique (notificationId, subscriptionId)
   3. send PENDING deliveries ──► WebPushTransport (VAPID JWT + aes128gcm) ──► push service ──► device
   4. record result per delivery; 404/410 ⇒ subscription deactivated
   5. transient failures left ⇒ throw ⇒ SQS redelivers ⇒ only those deliveries are retried
                                                                          │
   Service worker (public/sw.js): push ⇒ showNotification ; click ⇒ focus/open app at /tasks/<id>
```

* **Idempotency:** duplicate/redelivered events never create a second `Notification` or `PushDelivery`; a delivery that is `SENT` is never sent again. The RFC 8030 `Topic` header is the notification id, so a resend replaces a still-queued copy at the push service, and the OS notification `tag` (`n-<id>`) collapses any duplicate on the device.
* **Retries:** 429 / 5xx / network / timeout → delivery stays `PENDING`, the SQS message is redelivered (visibility timeout; DLQ after 5 receives). After `PUSH_MAX_ATTEMPTS` (5) a delivery becomes `FAILED`. 400/403/413 are permanent (`FAILED`, no retry).
* **Expiry:** 404/410 → `EXPIRED`, subscription `isActive=false` (`deactivationReason`), never used again. A browser re-subscribing the same endpoint reactivates it. Browser-reported `expirationTime` is honoured by the maintenance job. 20 consecutive failed deliveries also deactivate a subscription.
* **Recipients/authorization:** unchanged (assignee / project managers rules in `processor.ts`; actor excluded; inactive users and removed members skipped). Pushes contain only what the in-app notification shows; ratings are never part of any notification.
* **Events:** TASK_ASSIGNED, TASK_UPDATED, TASK_REASSIGNED, TASK_COMMENT_ADDED, TASK_COMPLETED, TASK_OVERDUE (urgency high, `requireInteraction`), TASK_DEADLINE_APPROACHING (urgency high), TASK_REOPENED, PUSH_TEST. Text is localized (EN/AR) per recipient.

## Database (migration `20261116095111_web_push_subscriptions`)

| Table | Purpose |
|---|---|
| `PushSubscription` | id, userId, **endpoint (unique)**, p256dh, auth, userAgent, platform (IOS/ANDROID/DESKTOP/OTHER), isActive, expiresAt, lastUsedAt, failureCount, lastFailureAt, deactivatedAt, deactivationReason, createdAt, updatedAt. Many per user. CHECKs: endpoint http(s) ≤ 2048, key lengths, inactive ⇒ deactivatedAt. |
| `PushDelivery` | One row per (notification, subscription): status PENDING/SENT/FAILED/EXPIRED, attempts, statusCode, lastError, sentAt. Kept 30 days. |
| `NotificationType` | + `PUSH_TEST` |
| removed | `DeviceInstallation`, `PushTicket`, enum `DevicePlatform` (Expo; both tables were empty — no app ever shipped) |

VAPID keys are **not** stored in the database.

## API (`/api/v1/push`)

| Method & path | Auth | Description |
|---|---|---|
| `GET /push/vapid-public-key` | public | `{ enabled, publicKey }` for `PushManager.subscribe` |
| `POST /push/subscribe` | user | Body = `PushSubscription.toJSON()`. Owner is always the caller (any `userId` in the body is ignored); an endpoint registered by someone else moves to the caller (shared device). Endpoint host must be a known push service (SSRF allow-list). → `201 { id, endpointHash }` |
| `DELETE /push/unsubscribe` | user | `{ endpoint }` (this browser) or `{ id }` (one of my devices). Other users' rows are never touched. → `204` |
| `GET /push/status` | user | `{ enabled, vapidPublicKey, subscriptions[] }` with device label, platform, active flag, `endpointHash` (sha256 prefix), last delivery. **Never** returns endpoint, p256dh or auth. |
| `POST /push/test` | user | Queues a `PUSH_TEST` via the outbox to the caller's active subscriptions. `202 { queued, subscriptions }` = queued, **not** delivered. 400 without an active subscription; 429 after 3/minute per user. |

The old `POST/DELETE /devices` (Expo tokens) endpoints were removed (no client used them).

## Service worker (`apps/web/public/sw.js`, VERSION v2)

* `push`: parses the `PushPayload` (packages/shared-types), **always** calls `showNotification` (required by `userVisibleOnly`; Safari revokes subscriptions that receive silent pushes) with title, body, `icon` (192 px), `badge` (monochrome 96 px for the Android status bar), `tag`, `requireInteraction` for overdue, and `data.path`. Updates the app-icon badge (`setAppBadge`) and tells open windows to refresh.
* `notificationclick`: marks the notification read (`/bff/notifications/:id/read`), refreshes the badge, then focuses an open app window and navigates it in-app (`dt:navigate` message, acked), falls back to `client.navigate()`, or opens a new window (`clients.openWindow`), which launches the installed PWA. Only same-origin paths are ever opened.
* `pushsubscriptionchange`: re-subscribes with the server's VAPID key and registers the new subscription.
* Updates: new worker activates immediately (`skipWaiting` + `clients.claim`); safe because no HTML is cached and handlers are stateless. `/sw.js` is served `no-cache`.

## Web app

* **`/settings/notifications`** (also linked from More, Settings and Notifications): checks for installed app / push support / permission / subscription, **Enable notifications** (the only place permission is requested; never on page load), **Send test notification**, **Turn off on this device**, the list of the user's devices (remove any), install + enable instructions for iPhone and Android, and recovery instructions when permission is **denied**. In an iOS Safari tab it explains that the app must be added to the Home Screen first.
* On launch (signed in, permission already granted) the existing browser subscription is re-registered silently (refresh / reactivation / re-binding to the current user).
* **Sign-out** removes this device's subscription on the server and in the browser, so the next person signing in on a shared device must opt in themselves.

## Configuration

| Variable | Service | Notes |
|---|---|---|
| `WEB_PUSH_VAPID_PUBLIC_KEY` | api, worker | base64url public key (public by design). Empty ⇒ push disabled (in-app notifications still work). |
| `WEB_PUSH_VAPID_PRIVATE_KEY` | **worker only** | Secrets Manager in AWS. Never in the DB, never in the API, never logged. |
| `WEB_PUSH_SUBJECT` | worker | `mailto:` or `https:` contact for push services (CDK defaults to `mailto:<alarmEmail>`). |
| `WEB_PUSH_ALLOWED_HOSTS` | api, worker | Comma-separated host suffixes. Default: `fcm.googleapis.com, push.apple.com, push.services.mozilla.com, notify.windows.com`. |
| `WEB_PUSH_ALLOW_INSECURE_ENDPOINTS` | api, worker | `http://` endpoints for the local fake push service. **Refused in production.** |
| `WEB_PUSH_TIMEOUT_MS` / `WEB_PUSH_CONCURRENCY` | worker | default 10000 / 10 |
| `PUSH_ENABLED` | worker | master switch |

Generate keys: `pnpm push:keys`. `docker-compose.yml` ships a **local-development key pair** so the stack works out of the box; production config validation rejects that public key. Rotating keys invalidates all browser subscriptions (users re-enable; the web app detects a key mismatch and re-subscribes on Enable).

AWS (CDK context): `<env>:vapidPublicKey`, `<env>:vapidPrivateKeySecretArn` (secret string = private key), optional `<env>:vapidSubject`. Without both, the worker runs with `PUSH_ENABLED=false`. CloudWatch metric `<env>-push-failures` (log message `push delivery failed`) with an alarm at ≥ 25 per 15 min → SNS. HTTPS on the ALB (ACM certificate) is required for service workers/push on phones.

## Tests

| Layer | What is proven |
|---|---|
| `apps/worker/test/push.test.ts` | multiple devices; duplicate events; 410 ⇒ deactivated & not reused; transient ⇒ retry of only the failed device; give-up after 5; permanent failures; exceptions; push disabled; overdue urgency; PUSH_TEST scope + localization; expiry maintenance; SSRF allow-list; status classification; **real `WebPushTransport` against a local push service: VAPID JWT signature verified, aes128gcm payload decrypted with the browser key**; production env guards |
| `apps/api/test/push.e2e-spec.ts` | auth required; caller-owned subscriptions; validation + host allow-list; multiple devices, no duplicate endpoints, re-binding, reactivation; status never leaks endpoint/keys; unsubscribe only own; test push via outbox, 400 without subscription, 429 per-user limit; cascade on user delete |
| `apps/web/src/lib/sw.test.ts` | service worker in a sandbox: notification options, badge, unparseable payload still shown, no external deep links, click with app closed (opens + marks read), app open (focus + in-app navigation), unresponsive window (navigate fallback), other origins ignored |
| `scripts/docker-smoke-test.mjs` | real containers: subscribe, task assignment ⇒ worker ⇒ encrypted push decrypted at a fake push service, 410 device deactivated, test push exactly once, unsubscribe |
| Manual check (desktop Chrome + real FCM) | Enable button ⇒ real `fcm.googleapis.com` subscription ⇒ test push and task-assigned push **displayed** by the service worker (~1 s) with deep link `/tasks/<id>` |

**A successful API response is not proof of delivery.** The real-device checklist below is the acceptance test.

## Real-device checklist

Record results in [REAL_DEVICE_TESTS.md](REAL_DEVICE_TESTS.md) (status: not yet executed).

Prerequisites: staging (or a tunnel) on **HTTPS** with real VAPID keys; a test employee and manager; the manager on a computer.

### iPhone / iPad (iOS/iPadOS 16.4 or later)
1. ☐ In **Safari**, open the site, sign in. Notification settings shows "Install the app to get notifications on iPhone"; there is **no** Enable button in the tab.
2. ☐ Share → **Add to Home Screen** → Add. Icon and name "DailyTasks" are correct (apple-touch-icon).
3. ☐ Open from the Home Screen: no Safari UI (standalone). Sign in again (separate cookie jar).
4. ☐ More → Notification settings: "Opened as installed app: Yes", "Push supported: Yes", permission "Not asked yet". No prompt appeared on its own.
5. ☐ Tap **Enable notifications** → iOS prompt → Allow. Subscription "Active"; device listed as "Safari on iPhone".
6. ☐ **Send test notification** with the app **open** → banner appears; list refreshes.
7. ☐ Swipe home (app **in background**), manager assigns a task → banner arrives; tapping it opens the app **on that task**.
8. ☐ Force-quit the app (app **closed**), manager comments on the task → notification arrives; tapping it launches the app on the task.
9. ☐ **Lock the phone**, manager reopens a task → notification on the lock screen; tap → Face ID → app opens on the task.
10. ☐ Home Screen icon shows the unread **badge** count; opening the notification decreases it.
11. ☐ Overdue alert arrives when a deadline passes (allow a few minutes).
12. ☐ Settings → Notifications → DailyTasks → turn off. Back in the app: permission "Blocked" and the recovery instructions show. Turn back on → works again.
13. ☐ Delete the Home Screen app → next push to that device returns 410; Notification settings on another device shows it **Inactive** ("push service returned 410").
14. ☐ Focus / Do Not Disturb on: notification is held (expected OS behaviour); arrives in the summary.
15. ☐ Arabic: switch language → push text arrives in Arabic, RTL.

### Android (Chrome)
1. ☐ Open the site in Chrome, sign in; **Install app** (banner/menu). App opens standalone.
2. ☐ Notification settings → **Enable notifications** → Allow (Android 13+ shows the system prompt). Device "Chrome on Android".
3. ☐ Test notification with the app open; then with the app in the background; then after swiping it away from recents (closed); then with the screen **locked**. All arrive (Doze may delay low-urgency messages; overdue/deadline are sent with high urgency).
4. ☐ Status-bar icon is the monochrome badge; notification shows the app icon.
5. ☐ Tap a task notification → installed app opens (or focuses) on the task.
6. ☐ Long-press app icon → App info → Notifications off → Notification settings shows "Blocked" + instructions; re-enable works.
7. ☐ Clear Chrome site data / uninstall → next push returns 404/410 → device shown Inactive.

### Cross-device
1. ☐ Same user on iPhone **and** Android: one event ⇒ one notification on **each** device.
2. ☐ Sign out on the iPhone ⇒ that device stops receiving; the Android device still receives.
3. ☐ Another user signs in on the same phone ⇒ receives nothing until they Enable notifications themselves.
4. ☐ Retrigger the same event (e.g. SQS redelivery) ⇒ no duplicate notification on the device.
5. ☐ CloudWatch: `push-failures` metric stays near 0; `PushDelivery` rows show `SENT 201` (Apple/FCM).

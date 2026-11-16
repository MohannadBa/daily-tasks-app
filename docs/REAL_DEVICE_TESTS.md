# Real-device test record

**Status: NOT EXECUTED.** No physical iPhone or Android device has been tested yet. The application is **not** production-ready until this record is completed and signed off.

Automated tests cannot prove that an operating system shows a notification on a real phone (closed app, locked screen, Focus modes, battery optimisation). A `202`/`201` from our API or a push service only means "accepted".

## What automation already covers (and what it does not)

| Capability | Automated evidence | Needs a physical device? |
|---|---|---|
| Manifest, icons, installability | Chrome DevTools protocol: 0 installability errors on an HTTPS origin | **Yes**: Add to Home Screen on iOS, install on Android |
| Standalone launch, no browser UI | `display: standalone` + iOS meta tags present | **Yes** |
| Service worker scope `/`, update headers | HTTPS check | No |
| Secure cookies on HTTPS | HTTPS check (Secure, HttpOnly, SameSite=Lax) | Recommended (iOS standalone has its own cookie jar) |
| Permission only after a tap | code + `sw.test.ts`/page logic; never requested on load | **Yes** (iOS prompt behaviour) |
| Subscription creation | desktop Chrome → real FCM | **Yes**: Apple (`web.push.apple.com`) only on iOS |
| Encryption + VAPID | worker test decrypts the payload; Docker smoke test | No |
| Delivery & display | desktop Chrome via real FCM: displayed ≈ 1 s | **Yes**: iOS/Android background, closed, locked |
| Click → task deep link | `sw.test.ts` (closed/open/unresponsive window) | **Yes** |
| 410 expiry, retries, duplicates, multi-device | worker + smoke tests | Partly (real uninstall → 410) |

## Prerequisites
* Staging deployed with **HTTPS** + real VAPID keys (docs/DEPLOYMENT.md). Plain HTTP or a LAN IP will not work.
* Test accounts: 1 employee (devices under test), 1 manager (computer).
* Note device model, OS version and browser version below.

## Devices
| Device | OS version | Browser | Tester | Date |
|---|---|---|---|---|
| iPhone (iOS ≥ 16.4) | | Safari | | |
| Android | | Chrome | | |

## Results (fill in: ✅ pass · ❌ fail + notes · ⏭ not applicable)

| # | Test | iPhone | Android | Notes |
|---|---|:-:|:-:|---|
| 1 | Open site in Safari / Chrome over HTTPS, sign in | | | |
| 2 | Notification settings in a Safari **tab** explains "Add to Home Screen first" (no Enable button) | | ⏭ | |
| 3 | Add to Home Screen / Install app; icon + name correct | | | |
| 4 | Standalone launch (no browser bars), sign in, stays signed in after closing the app | | | |
| 5 | No permission prompt appears without tapping **Enable notifications** | | | |
| 6 | Tap Enable → OS prompt → Allow → subscription "Active" | | | |
| 7 | **Send test notification**: app open | | | |
| 8 | **New task** assigned by manager: app in background | | | |
| 9 | **Task completion** (employee completes; manager's device receives) | | | |
| 10 | **Overdue** alert after a deadline passes (allow a few minutes) | | | |
| 11 | Notification with the app **closed** (swiped away / force-quit) | | | |
| 12 | Notification on a **locked** phone | | | |
| 13 | Tap notification → app opens **on that task** (deep link) | | | |
| 14 | Tap notification while the app is open on another screen → navigates to the task | | | |
| 15 | App icon unread badge updates | | | |
| 16 | **Subscription persistence**: reboot the phone / wait 24 h → test push still arrives | | | |
| 17 | Disable notifications in system settings → page shows "Blocked" + instructions; re-enable works | | | |
| 18 | Sign out → no more pushes to this device; another user signing in gets none until they enable | | | |
| 19 | Uninstall/delete the app → next push marks the device **Inactive** (410) on the other device's list | | | |
| 20 | Same user on both phones: one event → one notification on each | | | |
| 21 | Arabic profile: notification text in Arabic, RTL in the app | | | |
| 22 | Typical delay observed (seconds), Focus/Do-Not-Disturb behaviour noted | | | |

## Sign-off
| Role | Name | Date | Result |
|---|---|---|---|
| QA | | | |
| Product owner | | | |

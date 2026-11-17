# Real-device test record

**Status: NOT EXECUTED.** No physical iPhone or Android device has been tested yet. The application is **not** production-ready until this record is completed and signed off. Do not mark any step as passed unless it was performed on a physical phone.

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
* Production deployed in **restricted acceptance mode** with HTTPS on the CloudFront address `https://<id>.cloudfront.net` (no custom domain yet; after a domain is connected, re-install and repeat the push tests) and real VAPID keys ([PRODUCTION_PLAN.md](PRODUCTION_PLAN.md)); both test accounts (E and M) must be in `ACCESS_ALLOWLIST`. If `ALLOWED_CIDRS` is set, phones on mobile data are blocked — leave it empty for these tests. Plain HTTP, the ALB DNS name or a LAN IP will not work (no service worker, no push, no install on iOS).
* `curl https://<domain>/api/v1/push/vapid-public-key` → `{"enabled":true,…}`.
* Accounts: **E** = employee (the phone under test), **M** = project manager (on a computer). E belongs to a project + department where M can assign tasks.
* Phones: iPhone with **iOS ≥ 16.4** (Web Push for Home Screen apps), Android with current Chrome. Do Not Disturb / Focus **off** unless a step says otherwise. Record device model and OS/browser versions.

## Devices
| Device | Model | OS version | Browser version | Tester | Date |
|---|---|---|---|---|---|
| iPhone | | | Safari | | |
| Android | | | Chrome | | |

## Procedure — physical iPhone
| # | Step | Expected result | Result | Notes / evidence |
|---|---|---|:-:|---|
| I1 | Open `https://<domain>` in **Safari**, sign in as E | Login works; Arabic UI, RTL | | |
| I2 | Notification settings in the Safari **tab** | Explains "Add to Home Screen first"; no Enable button | | |
| I3 | Share → **Add to Home Screen** | Al-Rasiyat icon + name on the Home Screen | | |
| I4 | Launch from the icon | **Standalone**: no Safari bars; signed in (or sign in once); stays signed in after closing | | |
| I5 | Confirm no permission prompt appeared yet | No prompt without a tap | | |
| I6 | Notification settings → **Enable notifications** → Allow | Status **Active**; device listed (iOS) | | |
| I7 | **Send test notification** with the app open | Notification shown | | |
| I8 | M assigns a new task to E (computer); app in **background** | "New task" notification within seconds | | delay: |
| I9 | **Lock** the iPhone; M adds a reply / assigns another task | Notification on the lock screen | | delay: |
| I10 | Swipe the app away (closed); M triggers another event | Notification still arrives | | |
| I11 | **Tap** the notification | App opens **on that task** (correct title) | | |
| I12 | App open on another screen; tap a new notification | Navigates to the task | | |
| I13 | Home-screen badge | Unread count shown / cleared after reading | | |
| I14 | **Restart the iPhone**; M assigns a task | Notification still arrives (subscription persisted) | | |
| I15 | Arabic notification text | Title/body in Arabic | | |
| I16 | Settings → Notifications → Al-Rasiyat → off | App shows "Blocked" + instructions; re-enabling works | | |
| I17 | Sign out in the app; M triggers an event | No notification on this phone | | |
| I18 | Delete the app; M triggers an event; check E's device list on another device | Device becomes **Inactive** (410) | | |

## Procedure — physical Android
| # | Step | Expected result | Result | Notes / evidence |
|---|---|---|:-:|---|
| A1 | Open `https://<domain>` in **Chrome**, sign in as E | Login works | | |
| A2 | Install (banner or ⋮ → Install app) | App icon in the launcher; opens standalone | | |
| A3 | Notification settings → **Enable notifications** → Allow | Status **Active** | | |
| A4 | **Foreground**: app open, M assigns a task | Notification shown (or in-app toast + notification) | | |
| A5 | **Background**: switch to another app; M triggers an event | Notification within seconds | | delay: |
| A6 | **Locked**: screen off; M triggers an event | Notification on the lock screen | | delay: |
| A7 | App swiped away; M triggers an event | Notification arrives | | |
| A8 | Tap the notification | App opens **on that task** | | |
| A9 | App open elsewhere; tap a new notification | Navigates to the task | | |
| A10 | **Restart the phone**; M assigns a task | Notification arrives (subscription persisted) | | |
| A11 | Battery saver on (optional) | Note behaviour/delay | | |
| A12 | Sign out → event | No notification | | |
| A13 | Uninstall → event | Device becomes **Inactive** | | |

## Cross-device
| # | Step | Expected | Result | Notes |
|---|---|---|:-:|---|
| X1 | E signed in on both phones; one event | One notification on **each** phone, no duplicates | | |
| X2 | M approves E's submission | E receives "Task approved" on both phones | | |
| X3 | Typical delay (s) iPhone / Android | | | |

## Sign-off
| Role | Name | Date | Result |
|---|---|---|---|
| QA | | | NOT EXECUTED |
| Product owner | | | NOT EXECUTED |

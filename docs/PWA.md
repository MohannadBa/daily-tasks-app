# Installable web app (PWA)

DailyTasks has **no native mobile app**. The Next.js app in `apps/web` serves desktop browsers, phone browsers and the installed Home Screen app from one responsive codebase, against the same REST API (through the `/bff` proxy).

## Installing

| Device | Steps |
|---|---|
| iPhone / iPad | Open the site in **Safari** → **Share** → **Add to Home Screen** → **Add**. (Other iOS browsers are told to switch to Safari.) |
| Android | Chrome shows **Install app** (our in-app button uses the native prompt), or browser menu ⋮ → **Install app / Add to Home screen**. |
| Desktop Chrome/Edge | Install icon in the address bar, or the **Install app** button in *Profile & settings*. |

In the app: a dismissible banner on **Home** (phones only, hidden for 14 days after "Not now", never shown once installed), and an **Install the app** card in *Profile & settings* (`/settings#install`, also linked from the **More** sheet).

**HTTPS is required** for service workers and install everywhere except `localhost`. To try it on a real phone, use the deployed HTTPS URL or an HTTPS tunnel to port 3001. Plain `http://<LAN-IP>:3001` works as a website but won't install.

## What is implemented

| Piece | Where |
|---|---|
| Web App Manifest (`/manifest.webmanifest`): `id`/`start_url`/`scope` `/`, `display: standalone`, theme/background colours, 192/512 icons (any + maskable), shortcuts | `apps/web/src/app/manifest.ts` |
| Icons: `icons/icon-{192,512}.png`, `icons/maskable-{192,512}.png`, `apple-touch-icon.png` (180), `favicon-32.png`, `icon.svg` | `apps/web/public`, regenerate with `node scripts/generate-icons.mjs` (from `apps/web`) |
| iOS metadata: `apple-mobile-web-app-capable`, title, status-bar style, apple-touch-icon; viewport `viewport-fit=cover`; `theme-color` | `apps/web/src/app/layout.tsx` |
| Metadata in `<head>` (not streamed into `<body>`, where browsers ignore it) | `htmlLimitedBots: /.*/` in `apps/web/next.config.ts` |
| Service worker, served `no-cache` with `Service-Worker-Allowed: /` | `apps/web/public/sw.js`, headers in `next.config.ts` |
| Registration (production builds only), install-prompt capture, platform detection | `apps/web/src/lib/pwa.ts` |
| Offline shell (EN/AR from the `dt_locale` cookie; retries automatically when back online) | `apps/web/public/offline.html` |
| Public PWA paths excluded from the auth redirect | `apps/web/src/middleware.ts` matcher |

### Service-worker caching policy
The app shows private, per-user data, so caching is deliberately conservative:

* **Pages:** always fetched from the network (with navigation preload). Offline → `/offline.html` is served *at the requested URL*, so "Try again" reopens the same deep link. Authenticated HTML is **never cached**, so nothing leaks between users of a shared device.
* **`/bff/*`, `/session/*`, `/health`:** not intercepted. API data and auth always use the network.
* **`/_next/static/*`:** cache-first (content-hashed, immutable), capped at 300 entries.
* **Icons, manifest, offline page:** stale-while-revalidate.
* **Cross-origin (S3 pre-signed URLs):** not intercepted.

Bump `VERSION` in `sw.js` when its precache list or policy changes. Old `dt-*` caches are deleted on activate. The new worker activates immediately, which is safe because no HTML is cached.

### Deep links
* Every screen has a stable URL (`/tasks/<id>`, `/projects/<id>`, `/notifications`, …) inside the manifest scope.
* Signed out → `/login?next=<path+query>` → back to the original screen after sign-in (middleware and the client's 401 handler both keep the query string).
* The installed app has no browser back button, so the mobile top bar shows **Back** on nested screens. It goes back within the app session, or to the parent screen when the screen was opened directly (e.g. from a notification).

### Sessions & language in the installed app
* On iOS the installed app has its own cookie jar (separate from Safari), so users sign in once inside the app. Session cookies are persistent (refresh cookie 30 days), so closing the app doesn't sign the user out.
* Language: the `dt_locale` cookie (1 year) wins. Otherwise the device language (`Accept-Language`) on first launch. After sign-in the profile language is adopted when no cookie exists. Switching language also updates the profile, so notifications follow it.

## Mobile UI
* **Phones (< 1024 px):** sticky top app bar (title, Back, language), bottom tab bar (Home · Tasks · Projects · Alerts with unread badge · More), and a **More** bottom sheet (Employees / Team by role, Profile & settings, Install, Language, Sign out). Safe-area insets (notch, home indicator) are respected.
* **Desktop:** unchanged sidebar layout.
* Touch targets ≥ 40–44 px on phones, 16 px form text (prevents iOS focus-zoom), `touch-action: manipulation`, no horizontal page overflow (`overflow-x: clip`). Task and employee tables become card lists below 768 px.
* Verified at 390×844 in English (LTR) and Arabic (RTL): login, dashboard, projects, task list, task detail (replies, attachments, completion), manager rating view, employees, new task, notifications, settings. No horizontal overflow on any screen.

## Not yet done
* Push notifications are implemented — see [PUSH_NOTIFICATIONS.md](PUSH_NOTIFICATIONS.md).
* Offline data (read-only cached task lists) is intentionally out of scope for privacy reasons; revisit if needed.

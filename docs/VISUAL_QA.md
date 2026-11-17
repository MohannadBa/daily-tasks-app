# Visual QA record

**Scope:** screenshots of every listed screen in Arabic and English (desktop 1280 px), key screens on a phone viewport (390 px, Arabic), and the two Arabic PDFs rendered by the real worker (headless Chromium) and rasterized page by page. Environment: local Docker stack (2026-11-17). Reviewed by eye from the captures.
**Not covered here:** physical phones (see REAL_DEVICE_TESTS.md) and the staging domain — repeat the spot-check on staging (STAGING_PLAN.md §5.13).

## Results
| Screen | AR | EN | Phone (AR) | Notes |
|---|:-:|:-:|:-:|---|
| Dashboard (admin / manager / employee) | ✅ | ✅ | ✅ | Role-specific tiles, workload, personal-task card separate |
| Task details | ✅ after fix | ✅ | ✅ after fix | Bidi fix for "name · date" lines (see below) |
| Review inbox | ✅ | ✅ | ✅ | Thumbnails, accountable time, deadlines |
| Incoming transfers | ✅ | ✅ | — | |
| Documents (grid, list, preview) | ✅ after fix | ✅ | ✅ | Preview fallback added for missing files |
| Departments | ✅ after fix | ✅ | — | Inactive departments now listed last |
| Personal tasks | ✅ | ✅ | ✅ | Lock notice, priorities, due dates |
| Reports | ✅ | ✅ | — | Job list, status badges, download |
| User administration | ✅ | ✅ | — | Role badges, "pending first sign-in" |
| Arabic task PDF | ✅ after fix | — | — | IBM Plex Sans Arabic embedded, logo, RTL |
| Arabic employee PDF | ✅ after fix | — | — | 88 pages for ~75 tasks (one task card never split) |

Checks performed: RTL/LTR alignment and mirrored icons, Arabic typography (IBM Plex Sans Arabic in app and PDF), logo rendering (sidebar, PDF header, thumbnails), table layout, image rendering (thumbnails + viewer), PDF page breaks, phone layout (no horizontal overflow — also enforced by Playwright at 390/820/1280 px in AR and EN), loading skeletons and empty states.

## Issues found and fixed
| # | Issue | Fix | Test |
|---|---|---|---|
| V1 | Arabic UI: a Latin name next to a date was reordered by the bidi algorithm ("سلّمها Omar Employee · 17 2026/11/…", stranded "،") in the workflow panel, decisions and tables | All Arabic dates, relative times and durations are wrapped in a right-to-left isolate (U+2067 … U+2069) in `lib/format.ts`; table deadline cells no longer wrap | `format.test.ts` |
| V2 | PDF history listed raw codes (`CREATED`, `EXTENSION_REQUESTED`) | Localized history labels (AR/EN) | worker `enterprise.test.ts` |
| V3 | PDF footer scrambled ("…5a24c · 1 / 2 · 65") | Direction-aware footer: company · `<ltr>`reference · "صفحة X من Y" / "Page X of Y" | worker test + rasterized PDF |
| V4 | PDF section headings orphaned at page bottoms; employee-report task cards split mid-card | `break-after: avoid` on headings, repeated table headers, compact task cards kept whole | worker test + rasterized PDF |
| V5 | PDF table dates wrapped ("ص" on its own line) | Non-breaking, bidi-isolated dates | worker test |
| V6 | Document preview showed the browser's broken-image icon when a file could not be loaded | Graceful message "The file could not be loaded. Try downloading it instead." | manual (capture) |
| V7 | Inactive departments listed before active ones | API orders active first | API e2e (departments) |

## Observations (no change needed)
* Broken-image placeholders on old local test data: LocalStack (local S3) is not persistent across restarts; the app's fallback behaves correctly. Not applicable to AWS S3.
* Local database contains test accounts/departments (QA runs, accounts switched to Admin manually); staging starts empty (demo seed refused in production mode).
* Workload names are truncated with an ellipsis when long — acceptable.

# Al-Rasiyat design system

Single source of truth: `apps/web/src/app/globals.css` (`@theme` tokens) and the components in `apps/web/src/components`.

## Brand
* **Logo:** official raster `apps/web/assets/brand/alrasiyat-logo-source.jpeg` (gold on white). `public/brand/logo-mark.svg` is a vector trace of the mark + Arabic wordmark, used for the UI and every icon. The full lockup is the mark plus "ALRASIYAT" set in letter-spaced type (`components/logo.tsx`). **Replace `logo-mark.svg` with an official vector (SVG/AI/PDF) when one is available**, then run `node scripts/generate-icons.mjs` in `apps/web`.
* **Brand colour:** gold **#C0903D**, measured as the mean of 1,853 solid logo pixels. The logo contains only this hue on white, so every brand shade is a tint/shade of hue 38°. No unrelated colours were introduced.

| Token | Hex | Use |
|---|---|---|
| `brand-50` / `100` / `200` | #FAF7F2 / #F4EDE1 / #E9DBC3 | selected nav, subtle fills, progress |
| `brand-300` / `400` | #DDC193 / #CEA764 | hover borders |
| **`brand-500`** | **#C0903D** | logo, stars, icons, focus ring (2.9:1 on white: graphics only) |
| `brand-600` | #8F6B2D | **primary buttons** (white text 4.8:1, WCAG AA) |
| `brand-700` / `800` | #795E2F / #5F4A25 | hover/active, gold text on white (6.1:1) |
| neutrals (`slate-*`, remapped) | #FAFAFA … #211F1C | warm greys of the brand hue; text `slate-900`, muted `slate-500` (5.2:1) |
| canvas / surface | #F7F6F3 / #FFFFFF | page background / cards |
| success | #15803D on #ECFDF3 | completed |
| warning | #C2410C on #FFF4EC | completed late, due soon (orange, clearly distinct from the gold) |
| danger | #DC2626 on #FEF2F2 | overdue, destructive actions |
| info | #3B6A8C on #EEF4F8 | in progress |

States: hover darkens one step, active two steps, disabled = 55% opacity + `not-allowed`, focus = 2px `brand-500` outline/ring with offset.

## Type, shape, motion
* **IBM Plex Sans Arabic** (Arabic + Latin, self-hosted by `next/font`), weights 400–700. 16px form text on phones (prevents iOS zoom).
* Radius: cards `--radius-card` (12px), controls 8px. Shadows: 1px hairline on cards; elevation only for menus, dialogs, toasts.
* Motion: 150ms colour transitions, 160ms toast/dialog entrance, skeleton shimmer; all disabled under `prefers-reduced-motion`.

## Components
`Button` (primary/secondary/danger/ghost, sm/md, loading), `LinkButton`, `Card`, `Badge` (tones), `Field`/`Input`/`Select`/`Textarea`, `Tabs`, `PageHeader`, `Empty` (with icon), `Skeleton`/`SkeletonList`, `ErrorBox`, `Logo`, `AuthLayout`, toasts + `confirm()` dialog (`components/feedback.tsx`, `useFeedback()`), `StatusBadge`, `TaskTable` (cards on phones), `Stars`/`StarInput`, `FilePicker` (with upload progress).

Rules: use tokens and components, never page-specific colours; logical utilities only (`ms-/me-/ps-/pe-/start-/end-`); confirm dialogs only for destructive or irreversible actions; every async action gives a toast or inline error.

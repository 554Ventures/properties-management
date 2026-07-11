# CLAUDE.md — apps/web

Workspace-specific rules; the root CLAUDE.md and `docs/ARCHITECTURE.md` §8 govern overall.

## Layout

- `src/api/client.ts` — the single fetch wrapper (all requests flow through it; attaches `VITE_DEV_BEARER_TOKEN` if set); `src/api/queries.ts` — TanStack Query hooks per endpoint; `src/api/sse.ts` — SSE-over-POST parser
- `src/state/chat.tsx` — ChatProvider: session lifecycle, reducer-driven transcript assembly from SSE events, answer rollback on failure, 409 resync
- `src/components/` — `shell/` (nav, breadcrumbs), `ui/` (primitives), `charts/` (Recharts wrapped in `ChartContainer`), `ai/` (`AiSurface`, `InsightCard`, `AiChip`), `chat/` (drawer + block renderers + `actionAllowlist.ts`)
- `src/native/` — iOS Capacitor shell integration (`docs/MOBILE.md`): the only static Capacitor import is `platform.ts`'s `isNativeApp()`; every plugin loads via dynamic `import()` behind it and no-ops in try/catch (version-skew guard). `@capacitor/*` versions are exact-pinned identically to `apps/mobile` — bump both together.
- `src/styles/tokens.css` — every color/motion token, incl. the AI-surface convention and dark-mode + reduced-motion overrides

## Rules

- **Types come from `@hearth/shared`** — never redeclare API shapes locally. Currency only via `formatUsd`/`formatUsdWhole`.
- **Design tokens only** — no ad hoc hex/rgb in components; Tailwind theme maps to the CSS custom properties in `tokens.css`. Chart series colors resolve exclusively from the `--chart-*` tokens via `colorRole`.
- **All AI-authored content renders inside `AiSurface`** (the one wrapper that applies the violet AI convention + ✦ badge). If you add a surface that shows model output, wrap it.
- **A11y bar (merge-blocking axe tests):** status = icon + text, never color alone (`StatusBadge`); charts require `title` + `description` and keep the "View as table" toggle; forms use visible labels + `aria-describedby` errors; new async content announces via the existing polite live regions (announce on block/message completion, never per token); modals/drawers use the shared focus-trap (`useFocusTrap` keeps `onClose` in a ref — don't add it to effect deps).
- **Motion:** use the motion tokens; anything animated must be disabled by the global `prefers-reduced-motion` override (chart entrance animations included).
- **Chat action cards:** `api_call` actions execute only if matched by `components/chat/actionAllowlist.ts`; blocked ones render disabled with the visible "isn't available from chat" note. Add new allowlist entries only for specific, deliberate write actions — never patterns like `POST /.*`. Email/settings/PATCH/DELETE are excluded on purpose (prompt-injection exfil surface).
- **SSE client semantics:** terminal events are `message_complete` | `awaiting_input` | `error`; any other stream close is surfaced as an error. The `/answer` resume stream reuses the same messageId and absolute block indices — the reducer gap-pads.
- **Mobile idioms (below `md`):** anchored popovers/inline button rows are desktop patterns. Table column filters render in the focus-trapped `BottomSheet` (see `DataTable`'s `FilterPopover`); per-row actions go through `ui/RowActions` (inline text buttons at `md+`, icon-only or "⋯"-menu-in-a-sheet on mobile). Fixed/sticky chrome must pad with `env(safe-area-inset-*)` — the iOS shell's WKWebView is edge-to-edge (`viewport-fit=cover` in index.html makes the insets non-zero there; they're 0 in browsers).
- Every page sets a title via `usePageTitle` and (except Dashboard) renders a breadcrumb.

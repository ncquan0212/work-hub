// The hub's one stylesheet (modules may add their own scoped rules through Module.css). No script anywhere:
// every state here is CSS. Breakpoints in rem, mobile first: 40rem (dock → tabs), 48rem (2 columns),
// 60rem (tabs on the brand row), 80rem (3 columns), 120rem (4 columns). Colour tokens are OKLCH; the night
// colourway follows the OS setting (no toggle: the CSP allows no script).
export const CSS = String.raw`
/* Hallmark · genre: modern-minimal · theme: Ultraviolet (dealt 3/3, seed personal-work-dashboard-mobile-5443·337ce6b4·2026-11-08·r0) · ultraviolet: lavender + night · shape: app screen · posture: restrained · modes: light+dark · redesign: full · scope: app · v2.0.0
 * critique: the old hub boxed six dashboards into a 1180px column with no picture of the numbers; this one runs edge to edge, opens on what waits for the owner, then the four apps' pulse
 * waive 37: system-ui for Outfit and Onest; neither covers Vietnamese and the CSP has no font-src
 * waive (Ultraviolet lowercase voice): sentence case, because Vietnamese labels and app names keep their capitals
 * waive (Ultraviolet one chromatic colour): good, warn and bad hues beside the violet, always with a glyph and a word
 * waive 44d (capped container): the owner asked for full screen; past 1920 the grid keeps its columns and stops at 2560 */
:root {
  --paper: oklch(95% 0.02 300); --paper-2: oklch(92% 0.03 300); --paper-3: oklch(89% 0.035 300); --raised: oklch(97.5% 0.012 300);
  --ink: oklch(18% 0.02 300); --ink-2: oklch(28% 0.03 300); --muted: oklch(44% 0.05 300);
  --rule: oklch(84% 0.04 300); --rule-2: oklch(70% 0.08 295);
  --accent: oklch(50% 0.25 290); --accent-deep: oklch(43% 0.22 290); --accent-soft: oklch(86% 0.08 295); --accent-ink: oklch(97% 0.01 300);
  --focus: oklch(50% 0.25 290);
  --good: oklch(44% 0.12 150); --warn: oklch(48% 0.11 60); --bad: oklch(49% 0.19 25);
  --good-bg: oklch(90% 0.05 150); --warn-bg: oklch(91% 0.06 80); --bad-bg: oklch(90% 0.05 25); --info-bg: var(--accent-soft); --mute-bg: var(--paper-3);
  --c-raw: oklch(72% 0.04 300); --c-ma7: var(--accent); --c-ma28: oklch(58% 0.14 305); --c-grid: var(--rule);

  --font: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  --text-xs: 0.8125rem; --text-sm: 0.875rem; --text-md: 1rem; --text-lg: 1.2rem; --text-xl: 1.44rem; --text-2xl: 1.728rem; --text-fig: 2.25rem;
  --space-3xs: 2px; --space-2xs: 4px; --space-xs: 8px; --space-sm: 12px; --space-md: 16px; --space-lg: 24px; --space-xl: 40px; --space-2xl: 64px;
  --radius-card: 16px; --radius-inner: 10px; --radius-pill: 999px;
  --gutter: max(var(--space-md), env(safe-area-inset-left), env(safe-area-inset-right)); --gap: var(--space-sm);
  --bar-h: 56px; --dock-h: 64px;
  --dur-micro: 120ms; --dur-short: 220ms; --ease-out: cubic-bezier(0.2, 0.7, 0.2, 1);
  --shadow-card: 0 1px 2px oklch(18% 0.02 300 / 0.06);
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) { :root {
  --paper: oklch(14% 0.02 290); --paper-2: oklch(17.5% 0.025 290); --paper-3: oklch(21% 0.03 290); --raised: oklch(23% 0.03 290);
  --ink: oklch(92% 0.04 300); --ink-2: oklch(80% 0.05 300); --muted: oklch(70% 0.06 300);
  --rule: oklch(28% 0.04 290); --rule-2: oklch(44% 0.07 292);
  --accent: oklch(55% 0.25 290); --accent-deep: oklch(48% 0.24 290); --accent-soft: oklch(36% 0.09 293); --accent-ink: oklch(97% 0.01 300);
  --focus: oklch(68% 0.2 290);
  --good: oklch(78% 0.14 150); --warn: oklch(82% 0.13 80); --bad: oklch(74% 0.15 22);
  --good-bg: oklch(28% 0.06 150); --warn-bg: oklch(29% 0.06 70); --bad-bg: oklch(29% 0.07 22);
  --c-raw: oklch(46% 0.04 300); --c-ma7: oklch(72% 0.17 290); --c-ma28: oklch(56% 0.12 300);
  --shadow-card: none;
} }
@media (min-width: 40rem) { :root { --gutter: max(var(--space-lg), env(safe-area-inset-left), env(safe-area-inset-right)); --gap: var(--space-md) } }
@media (min-width: 80rem) { :root { --gutter: var(--space-xl); --gap: var(--space-lg) } }

/* base */
*, *::before, *::after { box-sizing: border-box }
html, body { overflow-x: clip }
html { -webkit-text-size-adjust: 100%; text-size-adjust: 100% }
body { margin: 0; background: var(--paper); color: var(--ink); font: 400 var(--text-md)/1.5 var(--font); font-synthesis: none;
  -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility }
@media (prefers-color-scheme: dark) { body { font-weight: 350 } }
::selection { background: color-mix(in oklab, var(--accent) 28%, transparent) }
:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px }
h1, h2, h3 { font-weight: 600; letter-spacing: -0.015em; line-height: 1.2; margin: 0; text-wrap: balance; overflow-wrap: break-word; min-width: 0 }
h1 { font-size: var(--text-2xl) } h2 { font-size: var(--text-lg) } h3 { font-size: var(--text-md) }
p { margin: 0; text-wrap: pretty }
a { color: inherit; text-decoration: underline; text-decoration-color: var(--rule-2);
  text-decoration-thickness: 1.5px; text-underline-offset: 3px; transition: text-decoration-color var(--dur-micro) var(--ease-out) }
@media (hover: hover) { a:hover { text-decoration-color: var(--accent) } }
code, pre, .tag { font-family: var(--mono) }
code { font-size: 0.9em }
img, svg { max-width: 100% }

/* shell: brand row with tabs (≥ 40rem) or a bottom dock (phones) */
.top { position: sticky; top: 0; z-index: 300; background: color-mix(in oklab, var(--paper) 92%, transparent);
  -webkit-backdrop-filter: saturate(1.4) blur(12px); backdrop-filter: saturate(1.4) blur(12px); border-bottom: 1px solid var(--rule);
  padding-top: env(safe-area-inset-top) }
.top-in { max-width: 160rem; margin: 0 auto; padding: 0 var(--gutter); min-height: var(--bar-h);
  display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: center; column-gap: var(--space-lg) }
.wordmark { font-weight: 600; font-size: var(--text-lg); letter-spacing: -0.02em; text-decoration: none; white-space: nowrap; display: inline-flex; align-items: center; gap: var(--space-xs); min-height: 44px }
.wordmark svg { width: 22px; height: 22px; color: var(--accent); flex-shrink: 0 }
.clock { justify-self: end; text-align: right; font-size: var(--text-sm); color: var(--muted); line-height: 1.3; font-variant-numeric: tabular-nums; white-space: nowrap }
.clock b { color: var(--ink); font-weight: 600 }
/* the clock and, when a module lists notifications, the bell before it (accent count: unread is news, not trouble) */
.top-end { justify-self: end; display: flex; align-items: center; gap: var(--space-xs); min-width: 0 }
.bell { position: relative; display: inline-grid; place-items: center; width: 44px; height: 44px; flex-shrink: 0; border-radius: var(--radius-pill); color: var(--muted); text-decoration: none;
  transition: background-color var(--dur-micro) var(--ease-out), color var(--dur-micro) var(--ease-out) }
.bell svg { width: 22px; height: 22px }
.bell .count { position: absolute; top: 3px; right: 1px; min-width: 18px; height: 18px; font-size: 0.6875rem; background: var(--accent); color: var(--accent-ink) }
@media (hover: hover) { .bell:hover { color: var(--ink); background: var(--paper-2) } }
.tabs { display: none }
.tabs a, .dock a { text-decoration: none; color: var(--muted); white-space: nowrap; transition: background-color var(--dur-micro) var(--ease-out), color var(--dur-micro) var(--ease-out) }
.count { display: inline-grid; place-items: center; min-width: 20px; height: 20px; padding: 0 var(--space-2xs); border-radius: var(--radius-pill);
  background: var(--bad); color: var(--paper); font-size: 0.75rem; font-weight: 600; font-variant-numeric: tabular-nums; line-height: 1 }
.dock { position: fixed; z-index: 300; inset: auto 0 0 0; display: grid; grid-template-columns: repeat(var(--n, 6), minmax(0, 1fr));
  background: color-mix(in oklab, var(--paper) 94%, transparent); -webkit-backdrop-filter: saturate(1.4) blur(12px); backdrop-filter: saturate(1.4) blur(12px);
  border-top: 1px solid var(--rule); padding: 0 env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left) }
.dock a { position: relative; display: grid; justify-items: center; align-content: center; gap: var(--space-3xs); min-height: var(--dock-h); font-size: 0.6875rem; font-weight: 500; letter-spacing: -0.01em }
.dock svg { width: 24px; height: 24px; flex-shrink: 0 }
.dock a[aria-current="page"] { color: var(--ink) }
.dock a[aria-current="page"] svg { color: var(--accent) }
.dock .count { position: absolute; top: 6px; left: calc(50% + 6px); min-width: 18px; height: 18px; font-size: 0.6875rem }
body { padding-bottom: calc(var(--dock-h) + env(safe-area-inset-bottom)) }
@media (min-width: 40rem) {
  body { padding-bottom: 0 }
  .dock { display: none }
  .top-in { grid-template-columns: auto minmax(0, 1fr); grid-template-areas: "brand clock" "tabs tabs" }
  .wordmark { grid-area: brand } .top-end { grid-area: clock }
  .tabs { grid-area: tabs; display: flex; gap: var(--space-2xs); overflow-x: auto; scrollbar-width: none; margin: 0 calc(-1 * var(--space-xs)); padding: 0 var(--space-xs) var(--space-xs) }
  .tabs::-webkit-scrollbar { display: none }
  .tabs a { display: inline-flex; align-items: center; gap: var(--space-xs); min-height: 40px; padding: 0 var(--space-md); border-radius: var(--radius-pill); font-weight: 500; font-size: var(--text-sm) }
  .tabs svg { width: 18px; height: 18px; flex-shrink: 0 }
  .tabs a[aria-current="page"] { background: var(--paper-3); color: var(--ink) }
  .tabs a[aria-current="page"] svg { color: var(--accent) }
}
@media (min-width: 40rem) and (hover: hover) { .tabs a:hover { color: var(--ink); background: var(--paper-2) } }
@media (min-width: 60rem) {
  .top-in { grid-template-columns: auto minmax(0, 1fr) auto; grid-template-areas: "brand tabs clock" }
  .tabs { padding: 0; margin: 0; justify-content: center }
}

/* page: full width, capped at 2560px */
.page { max-width: 160rem; margin: 0 auto; padding: var(--space-lg) var(--gutter) var(--space-2xl); display: grid; gap: var(--space-lg); min-width: 0 }
.page-head { display: grid; gap: var(--space-2xs); min-width: 0 }
.crumb { font-size: var(--text-sm); color: var(--muted) }
.crumb a { color: inherit }
.page-head .lede { color: var(--muted); font-size: var(--text-sm) }

/* bare page (a chart's full-screen view): no brand row, no dock */
body.bare { padding-bottom: 0 }
.bare .page { padding-top: max(var(--space-sm), env(safe-area-inset-top)); padding-bottom: max(var(--space-lg), env(safe-area-inset-bottom)) }

/* the board: panels in 1 / 2 / 3 / 4 columns */
.board { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--gap); align-items: start; grid-auto-flow: row dense }
.board > * { min-width: 0 }
.span-all { grid-column: 1 / -1 }
@media (min-width: 48rem) { .board { grid-template-columns: repeat(2, minmax(0, 1fr)) } .span-2, .span-3 { grid-column: 1 / -1 } }
@media (min-width: 80rem) { .board { grid-template-columns: repeat(3, minmax(0, 1fr)) } .span-2 { grid-column: span 2 } }
@media (min-width: 120rem) { .board { grid-template-columns: repeat(4, minmax(0, 1fr)) } .span-3 { grid-column: span 3 } }
.board-head { grid-column: 1 / -1; display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--space-2xs) var(--space-sm); margin-top: var(--space-xs) }
.board-head:first-child { margin-top: 0 }
.board-head p { color: var(--muted); font-size: var(--text-sm) }
.board-head .act { margin-left: auto; font-size: var(--text-sm); white-space: nowrap }

/* panel: a step to paper-2, no border */
.panel, section { background: var(--paper-2); border-radius: var(--radius-card); padding: var(--space-md); min-width: 0; display: grid; gap: var(--space-sm); align-content: start }
@media (min-width: 40rem) { .panel, section { padding: var(--space-md) var(--space-lg) var(--space-lg) } }
.panel-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--space-2xs) var(--space-sm); min-width: 0 }
.panel-head h2 { flex: 0 1 auto }
.panel-head .note { color: var(--muted); font-size: var(--text-sm); flex: 0 1 auto; min-width: 0 }
.panel-head .act { margin-left: auto; font-size: var(--text-sm); white-space: nowrap }
.panel h3 { margin-top: var(--space-xs) }
.panel h3:first-child { margin-top: 0 }

/* text helpers kept from the first version, restyled */
.muted { color: var(--muted); font-weight: inherit }
.sub { font-size: var(--text-sm); margin-top: var(--space-3xs); overflow-wrap: anywhere }
.label { display: block; font-size: var(--text-sm); font-weight: 500; color: var(--muted) }
.big { font-size: var(--text-xl); font-weight: 600; font-variant-numeric: tabular-nums; letter-spacing: -0.01em }
.fig { font-size: var(--text-fig); font-weight: 300; line-height: 1; letter-spacing: -0.03em; font-variant-numeric: tabular-nums }
.ok-t { color: var(--good) } .warn-t { color: var(--warn) } .bad-t { color: var(--bad) }
.calm { color: var(--good) }
.wrap { overflow-wrap: anywhere }
.row { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2xs) var(--space-xs); min-width: 0 }
.row > * { min-width: 0; overflow-wrap: anywhere }
.inline { display: flex; flex-wrap: wrap; gap: var(--space-xs); align-items: center }
.cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 16rem), 1fr)); gap: var(--space-lg) }
.facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 12rem), 1fr)); gap: var(--space-sm) var(--space-lg) }
.facts > * { min-width: 0 }

/* chips: status (tinted, with a word) and tags (code, hairline) */
.pill { display: inline-flex; align-items: center; gap: var(--space-2xs); font-size: var(--text-xs); font-weight: 600; line-height: 1; padding: var(--space-2xs) var(--space-sm); border-radius: var(--radius-pill); white-space: nowrap; vertical-align: middle }
.pill.ok { color: var(--good); background: var(--good-bg) } .pill.warn { color: var(--warn); background: var(--warn-bg) }
.pill.bad { color: var(--bad); background: var(--bad-bg) } .pill.info { color: var(--ink); background: var(--info-bg) }
.pill.mute { color: var(--muted); background: var(--mute-bg) }
.tag { display: inline-block; font-size: var(--text-xs); line-height: 1.4; padding: var(--space-3xs) var(--space-xs); border-radius: var(--radius-pill); box-shadow: inset 0 0 0 1px var(--rule-2); white-space: nowrap; max-width: 100%; overflow: hidden; text-overflow: ellipsis; vertical-align: middle }
.delta { font-size: var(--text-sm); font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap }

/* lists */
.list { list-style: none; margin: 0; padding: 0; display: grid }
.list > li { padding: var(--space-sm) 0; border-top: 1px solid var(--rule); min-width: 0 }
.list > li:first-child { border-top: 0; padding-top: 0 } .list > li:last-child { padding-bottom: 0 }
.alerts { list-style: none; margin: 0; padding: 0; display: grid }
.alerts > li { padding: var(--space-sm) 0; border-top: 1px solid var(--rule); overflow-wrap: anywhere }
.alerts .pill { margin-right: var(--space-xs) }
.alerts > li:first-child { border-top: 0; padding-top: 0 } .alerts > li:last-child { padding-bottom: 0 }
.alerts .src { font-weight: 600 }
.alerts > li.has-seen { display: flex; align-items: center; gap: var(--space-sm) }
.alerts > li.has-seen > span { flex: 1 1 auto; min-width: 0 }
.alert-seen { flex-shrink: 0 } .alert-seen button { min-height: 32px; padding: 0 var(--space-sm); font-size: var(--text-xs) }
.empty { color: var(--muted); font-size: var(--text-sm); padding: var(--space-sm) 0 }

/* tables: hairline rows, sentence-case heads, the first column held on a phone */
.scroll { overflow-x: auto; overscroll-behavior-x: contain; margin: 0 calc(-1 * var(--space-md)); padding: 0 var(--space-md) }
@media (min-width: 40rem) { .scroll { margin: 0 calc(-1 * var(--space-lg)); padding: 0 var(--space-lg) } }
table { border-collapse: collapse; width: 100%; font-size: var(--text-sm); font-variant-numeric: tabular-nums }
th, td { text-align: left; padding: var(--space-xs) var(--space-sm); border-bottom: 1px solid var(--rule); white-space: nowrap; vertical-align: top }
th:first-child, td:first-child { padding-left: 0 } th:last-child, td:last-child { padding-right: 0 }
thead th { font-size: var(--text-xs); font-weight: 600; color: var(--muted); border-bottom-color: var(--rule-2); vertical-align: bottom }
tbody tr:last-child > * { border-bottom: 0 }
td.wrap { white-space: normal; min-width: 14rem }
.num { text-align: right; font-variant-numeric: tabular-nums }
@media (hover: hover) { tbody tr:hover > * { background: color-mix(in oklab, var(--paper-3) 55%, transparent) } }
@media (max-width: 47.99rem) {
  .scroll table tr > :first-child { position: sticky; left: 0; z-index: 1; background: var(--paper-2); box-shadow: 1px 0 0 var(--rule) ; padding-right: var(--space-sm) }
}

/* a table that restacks on a phone: one block per row, the first two cells (what the row is, its state) on top,
   the rest in two columns below, a td.wrap across both; a cell's data-label shows before its value */
@media (max-width: 47.99rem) {
  table.restack, table.restack tbody { display: block }
  table.restack thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap }
  table.restack tr { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: var(--space-2xs) var(--space-md); align-items: baseline; padding: var(--space-sm) 0; border-bottom: 1px solid var(--rule) }
  table.restack tbody tr:first-child { padding-top: 0 }
  table.restack tbody tr:last-child { border-bottom: 0; padding-bottom: 0 }
  .scroll table.restack tr > * { display: block; position: static; padding: 0; border: 0; box-shadow: none; background: none; white-space: normal; min-width: 0; text-align: left }
  .scroll table.restack tr > :nth-child(even) { justify-self: end; text-align: right }
  .scroll table.restack tr > td.wrap { grid-column: 1 / -1; justify-self: stretch; text-align: left }
  table.restack td:empty { display: none }
  table.restack td[data-label]::before { content: attr(data-label) " "; color: var(--muted) }
}

/* disclosure */
details > summary { cursor: pointer; list-style: none; display: inline-flex; align-items: center; gap: var(--space-2xs); color: var(--ink-2); font-size: var(--text-sm); font-weight: 500; min-height: 32px }
details > summary::-webkit-details-marker { display: none }
details > summary::before { content: ""; width: 7px; height: 7px; border-right: 1.5px solid currentColor; border-bottom: 1.5px solid currentColor; transform: rotate(-45deg); margin: 0 var(--space-2xs); transition: transform var(--dur-micro) var(--ease-out) }
details[open] > summary::before { transform: rotate(45deg) }
details[open] > summary { margin-bottom: var(--space-xs) }

/* forms: pill fields, one filled primary */
form { display: grid; gap: var(--space-sm); margin: 0; min-width: 0 }
input[type=text], input[type=number], input[type=date], input:not([type]), textarea, select {
  font: inherit; font-size: max(16px, var(--text-md)); color: var(--ink); background: var(--raised); border: 0; border-radius: var(--radius-pill);
  box-shadow: inset 0 0 0 1px var(--muted); padding: 0 var(--space-md); min-height: 44px; width: 100%; outline: 2px solid transparent; outline-offset: -3px }
textarea { border-radius: var(--radius-inner); padding: var(--space-sm) var(--space-md); min-height: 7rem; resize: vertical; line-height: 1.5 }
select { appearance: none; padding-right: var(--space-xl);
  background-image: linear-gradient(45deg, transparent 50%, var(--muted) 50%), linear-gradient(135deg, var(--muted) 50%, transparent 50%);
  background-position: calc(100% - 22px) 50%, calc(100% - 16px) 50%; background-size: 6px 6px; background-repeat: no-repeat }
input:focus-visible, textarea:focus-visible, select:focus-visible { outline-color: var(--focus); box-shadow: inset 0 0 0 1px var(--ink-2) }
@media (hover: hover) { input:hover, textarea:hover, select:hover { background-color: var(--paper) } }
input[type=checkbox] { accent-color: var(--accent); width: 18px; height: 18px; margin: 0 }
label { font-size: var(--text-sm); font-weight: 500 }
::placeholder { color: var(--muted); opacity: 1 }
button, .btn { font: inherit; font-size: var(--text-sm); font-weight: 600; display: inline-flex; align-items: center; justify-content: center; gap: var(--space-xs);
  min-height: 40px; padding: 0 var(--space-lg); border: 0; border-radius: var(--radius-pill); background: var(--accent); color: var(--accent-ink);
  cursor: pointer; justify-self: start; white-space: nowrap; text-decoration: none; transition: background-color var(--dur-micro) var(--ease-out), transform var(--dur-micro) var(--ease-out) }
@media (hover: hover) { button:hover, .btn:hover { background: var(--accent-deep) } }
button:active, .btn:active { transform: translateY(1px) }
button.ghost, .btn.ghost { background: transparent; color: var(--ink); box-shadow: inset 0 0 0 1.5px var(--rule-2) }
@media (hover: hover) { button.ghost:hover, .btn.ghost:hover { background: var(--paper-3); box-shadow: inset 0 0 0 1.5px var(--ink-2) } }
button.danger { background: transparent; color: var(--bad); box-shadow: inset 0 0 0 1.5px currentColor }
@media (hover: hover) { button.danger:hover { background: var(--bad-bg) } }
button:disabled { opacity: 0.55; cursor: not-allowed }
@media (pointer: coarse) { button, .btn { min-height: 44px } }

/* conversation */
.msg { padding: var(--space-sm) var(--space-md); border-radius: var(--radius-inner); background: var(--paper-3); overflow-wrap: anywhere; white-space: pre-wrap; max-width: 75ch }
.msg.me { background: var(--accent-soft); justify-self: end }
.msg .who { font-size: var(--text-xs); font-weight: 600; color: var(--muted); margin-bottom: var(--space-2xs); white-space: normal }
pre { font-size: var(--text-xs); line-height: 1.5; background: var(--paper-3); padding: var(--space-sm); border-radius: var(--radius-inner); overflow-x: auto; margin: 0 }

/* Markdown from Claude (core/md.ts): normal wrapping inside a pre-wrap .msg, spaced blocks */
.md { white-space: normal; min-width: 0 }
:where(.md) :is(ul, ol, blockquote, hr) { margin: 0 } /* :where keeps this below the spacing rules */
.md ul, .md ol { padding-left: 1.4em }
.md > * + *, .md li > ul, .md li > ol { margin-top: var(--space-xs) }
.md > * + h3 { margin-top: var(--space-md) }
.md li + li { margin-top: var(--space-3xs) }
.md li:has(> input) { list-style: none }
.md li > input { margin: 0 var(--space-xs) 0 -1.3em; vertical-align: -0.1em; accent-color: var(--accent) }
.md blockquote { padding-left: var(--space-sm); box-shadow: inset 2px 0 0 var(--rule-2); color: var(--muted) }
.md hr { border: 0; border-top: 1px solid var(--rule) }
.md pre, .md :not(pre) > code { background: var(--paper-2) }
.md :not(pre) > code { padding: 0.05em 0.35em; border-radius: 5px }

/* charts (lib/svg.ts) */
svg.chart { width: 100%; height: auto; display: block; overflow: visible }
svg.chart text { font: 500 11px var(--font); fill: var(--muted); font-variant-numeric: tabular-nums }
svg.chart .grid { stroke: var(--c-grid); stroke-width: 1 }
svg.chart .raw { stroke: var(--c-raw); stroke-width: 1.25; fill: none; stroke-linejoin: round }
svg.chart .s1 { stroke: var(--c-ma7); stroke-width: 2; fill: none; stroke-linejoin: round; stroke-linecap: round }
svg.chart .s2 { stroke: var(--c-ma28); stroke-width: 2; fill: none; stroke-linejoin: round; stroke-linecap: round; stroke-dasharray: 5 4 }
svg.chart .dot { fill: var(--c-ma7); stroke: var(--paper-2); stroke-width: 2 }
svg.chart .rug { stroke: var(--ink-2); stroke-width: 1.5 }
svg.chart .hit { fill: transparent }
@media (hover: hover) { svg.chart .hit:hover { fill: var(--ink); fill-opacity: 0.06 } }
svg.chart text.val { fill: var(--ink); font-weight: 600 }
.legend { display: flex; flex-wrap: wrap; gap: var(--space-2xs) var(--space-md); font-size: var(--text-xs); color: var(--muted) }
.legend i { display: inline-block; width: 16px; height: 2px; vertical-align: middle; margin-right: var(--space-2xs); border-radius: 1px }
.legend .raw { background: var(--c-raw) } .legend .s1 { background: var(--c-ma7) }
.legend .s2 { background: repeating-linear-gradient(90deg, var(--c-ma28) 0 5px, transparent 5px 9px) }
svg.spark { display: block; width: 100%; height: 40px; overflow: visible }
svg.spark .raw { stroke: var(--c-raw); stroke-width: 1.25; fill: none; vector-effect: non-scaling-stroke }
svg.spark .s1 { stroke: var(--c-ma7); stroke-width: 2; fill: none; stroke-linejoin: round; stroke-linecap: round; vector-effect: non-scaling-stroke }
svg.spark .area { fill: var(--c-ma7); fill-opacity: 0.1 }
@media (prefers-color-scheme: dark) { svg.spark .area { fill-opacity: 0.16 } }
/* bigChart (the zoom page): the plot stretches to its box, the labels are HTML placed in % so they keep their size */
.bigchart { display: grid; grid-template-columns: 3.75rem minmax(0, 1fr) 4.75rem; grid-template-rows: minmax(0, 1fr) 1.75rem; height: 100%;
  padding-top: var(--space-xs); font-size: var(--text-xs); line-height: 1; color: var(--muted); font-variant-numeric: tabular-nums }
.bigchart > div { position: relative; min-width: 0; min-height: 0 }
.bc-y span, .bc-end span { position: absolute; transform: translateY(-50%); white-space: nowrap }
.bc-y span { right: var(--space-xs) }
.bc-end span { left: var(--space-xs); color: var(--ink); font-weight: 600; font-size: var(--text-sm) }
.bc-x { grid-column: 2 }
.bc-x span { position: absolute; top: var(--space-xs); transform: translateX(-50%); white-space: nowrap }
@media (max-width: 39.99rem) { .bc-x .odd { display: none } }
.bigchart svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible }
.bigchart svg * { vector-effect: non-scaling-stroke }
.bigchart .grid { stroke: var(--c-grid); stroke-width: 1 }
.bigchart .raw { stroke: var(--c-raw); stroke-width: 1.5; fill: none; stroke-linejoin: round }
.bigchart .s1 { stroke: var(--c-ma7); stroke-width: 2.5; fill: none; stroke-linejoin: round; stroke-linecap: round }
.bigchart .s2 { stroke: var(--c-ma28); stroke-width: 2.5; fill: none; stroke-linejoin: round; stroke-linecap: round; stroke-dasharray: 6 5 }
.bc-rug { position: absolute; bottom: 0; width: 2px; height: 8px; margin-left: -1px; background: var(--ink-2) }
.bigchart .hit { fill: transparent }
@media (hover: hover) { .bigchart .hit:hover { fill: var(--ink); fill-opacity: 0.06 } }
.bc-dot { position: absolute; width: 10px; height: 10px; margin: -5px 0 0 -5px; border-radius: 50%; background: var(--c-ma7); box-shadow: 0 0 0 2px var(--paper) }
.charts { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 22rem), 1fr)); gap: var(--gap) }
.chart-card { min-width: 0 }
.chart-card .head { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--space-2xs) var(--space-sm); margin-bottom: var(--space-2xs) }

/* Hôm nay: the four apps' pulse */
.tiles { grid-column: 1 / -1; display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--gap) }
@media (min-width: 40rem) { .tiles { grid-template-columns: repeat(2, minmax(0, 1fr)) } }
@media (min-width: 80rem) { .tiles { grid-template-columns: repeat(4, minmax(0, 1fr)) } }
.tile { position: relative; background: var(--paper-2); border-radius: var(--radius-card); padding: var(--space-md); display: grid; gap: var(--space-xs); align-content: start; min-width: 0; text-decoration: none;
  transition: background-color var(--dur-micro) var(--ease-out) }
@media (min-width: 40rem) { .tile { padding: var(--space-md) var(--space-lg) var(--space-lg) } }
@media (hover: hover) { a.tile:hover { background: var(--paper-3) } }
.tile-name { display: flex; justify-content: space-between; align-items: baseline; gap: var(--space-xs); font-weight: 600 }
.tile-name span { font-weight: 400; color: var(--muted); font-size: var(--text-sm) }
.tile-fig { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--space-2xs) var(--space-xs) }
.tile-fig .unit { color: var(--muted); font-size: var(--text-sm) }
.kv { display: grid; gap: var(--space-2xs); margin: var(--space-2xs) 0 0; font-size: var(--text-sm) }
.kv > div { display: flex; justify-content: space-between; align-items: baseline; gap: var(--space-sm); padding-top: var(--space-2xs); border-top: 1px solid var(--rule) }
.kv dt { color: var(--muted) } .kv dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap }

@media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition-duration: 0.01ms !important; scroll-behavior: auto !important } }
@media print { .top, .dock { display: none } body { padding: 0 } .panel, section { break-inside: avoid } }
`

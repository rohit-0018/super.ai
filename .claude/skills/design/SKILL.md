---
name: qwai-design
description: The qwai visual language. Load this whenever touching any UI surface in apps/web (pages, components, styles), adding new screens, restyling, or designing marketing/auth/settings flows. Triggers on "design", "UI", "component", "page", "style", "theme", "redesign", "make it look nice", anything that renders in the browser.
---

# qwai design system — MetaMask-inspired pro trading terminal

> Canonical visual language. **Do not invent a new one. Do not drift to defaults.**
> If a task seems to need a rule change, ask first.

## The zero rule

**Never ship generic AI-dashboard UI.** No slate neutrals with a single indigo accent. No Vercel-white. No shadcn-default. qwai is a **professional trading terminal** in the MetaMask extension visual family: deep navy-black canvas, near-opaque dark cards with a 1px soft border + inner top highlight, pro-dense information, numbers treated as first-class citizens.

If a design would look at home on any other SaaS, it is wrong.

## References (study these — don't guess from memory)

- **MetaMask Portfolio / MetaMask extension** — card grammar, border + inner highlight, section headers, color temperament.
- **Hyperliquid / Drift / dYdX** — shell structure (left icon rail, top statusbar, persistent right panel, dense tables).
- **Linear** — density discipline, typographic restraint.

Do NOT reference: Stripe serif editorial, Duolingo playful, Notion, generic shadcn.

## Shell structure (non-negotiable)

qwai uses a **pro-terminal shell**, not a marketing navbar:

```
┌─────┬──────────────────────────────────────────────┬────────┐
│     │ TICKER  SOL 142.33 ▲  BTC 68,120 ▼  …        │  ⌘K    │
│ Ⓠ  ├──────────────────────────────────────────────┼────────┤
│     │                                              │        │
│ ◎   │                                              │        │
│ ◆   │          MAIN WORKSPACE                      │  CHAT  │
│ ◈   │          (per route)                         │ drawer │
│ ◐   │                                              │(toggle)│
│ ⚡   │                                              │        │
│ ⚙   │                                              │        │
│     ├──────────────────────────────────────────────┤        │
│     │ STATUS  paper · risk low · 3 agents · +2.3%  │        │
└─────┴──────────────────────────────────────────────┴────────┘
```

- **Left rail**: 56px wide, icons only, brand hex on top, tooltip on hover. Persistent.
- **Top statusbar**: 44px, scrolling ticker + ⌘K command + balance + paper/live pill.
- **Main workspace**: the route. Content here is focused and dense.
- **Right chat drawer**: 420px, collapsible via chevron/keybinding. Persistent by default on lg+.
- **Footer statusbar** (optional, 28px): paper/live, risk level, agents running, 24h P&L. Always mono.

Never fall back to a horizontal navbar on product routes. The marketing landing is allowed to use a minimal topbar.

## Palette (MetaMask-extension, locked)

Defined in `apps/web/app/globals.css`. **Never hardcode hex in components.**

| Role | Variable | Value | Notes |
|---|---|---|---|
| Canvas | `--bg` | `#0a0d14` | Deep navy-black. Not pure `#000`. |
| Canvas raised | `--bg-2` | `#0d1119` | |
| Card / surface | `--surface` | `#141820` | Near-opaque. The default card fill. |
| Surface 2 (nested) | `--surface-2` | `#1a1f2a` | Tables, inner lists. |
| Surface hover | `--surface-hover` | `#1f2430` | |
| Border | `--border` | `rgba(255,255,255,0.06)` | Soft white-alpha, not a gray. |
| Border 2 (strong) | `--border-2` | `rgba(255,255,255,0.10)` | Hover / focused. |
| Inner highlight | `--highlight` | `rgba(255,255,255,0.04)` | `inset 0 1px 0 …` on every card. |
| Text | `--text` | `#f5f6fa` | High contrast. Not pure white. |
| Text 2 | `--text-2` | `#8a8fa3` | |
| Text 3 | `--text-3` | `#5a5f73` | |
| **Accent (data)** | `--accent` | `#3b82f6` | Electric blue — links, primary CTA, data emphasis. |
| **Accent 2 (AI)** | `--accent-2` | `#a855f7` | Purple — AI / agent identity, learning moments. |
| Positive | `--ok` | `#22c55e` | |
| Warn | `--warn` | `#f59e0b` | MetaMask amber, critical for paper-mode chip. |
| Negative | `--bad` | `#ef4444` | |
| Ring / focus | `--ring` | `rgba(59,130,246,0.35)` | |

**Accent rules:**
- Blue is for *data / user actions* — links, primary buttons, selected state.
- Purple is for *AI / agent identity* — agent cards, chat assistant bubble, learning dots.
- Green/red only on actual gains/losses. Never decorative.
- Amber only for warnings (paper mode, risk flags, testnet).
- **No gradients in product UI.** Gradients are reserved for the brand hex mark only.
- **No glow text, no neon.** The MetaMask family is restrained. A card can have a subtle outer glow on hover, maximum.

## Typography

Three fonts, three jobs — never more:

| Use | Font | Var |
|---|---|---|
| Display (H1 hero, hero numbers, brand) | **Space Grotesk** 600 | `--font-display` |
| Body / UI | **Inter** | `--font-sans` |
| Numbers / mono / hashes | **JetBrains Mono** w/ `tnum` | `--font-mono` |

Type scale (pro-dense):

| Token | Size | Weight | Letter-spacing |
|---|---|---|---|
| `text-hero` | 48px | 600 | `-0.03em` |
| `text-h1` | 24px | 600 | `-0.02em` |
| `text-h2` | 18px | 600 | `-0.015em` |
| `text-body` | 13px | 400 | `-0.005em` |
| `text-sm` | 12px | 500 | 0 |
| `text-xs` | 11px | 500 | `0.02em` |
| `text-eyebrow` | 11px | 500 uppercase | `0.14em` |

Numbers: always mono, always `font-feature-settings: 'tnum' 1`. Hero portfolio number = 40-48px mono. Table cell numbers = 12-13px mono.

## Spacing (pro-dense)

Base unit 4px. Use 4 / 8 / 10 / 12 / 14 / 16 / 20 / 24 / 32.

- **Card padding**: 14px (compact) / 18px (default) / 24px (hero only). Never 32px.
- **Card header**: 12px top/bottom, 14px sides, divider below.
- **Button height**: 32px (default), 28px (sm), 36px (lg). Never 40+.
- **Input height**: 32px.
- **Table row**: 32px compact / 36px default. Never 44+.
- **Rail icon button**: 40px square.
- **Chip**: 20px tall, 8px side padding.
- **Radii**: 8px buttons/inputs, 10px chips, 12px cards, 14px drawer/modal, 999px pills.

## Card grammar (MetaMask signature)

**Every** product card uses this grammar. No snowflakes.

```tsx
<section className="section">
  <header className="section-header">
    <h3 className="section-title">Positions</h3>
    <div className="section-actions">
      <button className="btn btn-ghost btn-sm">See all</button>
    </div>
  </header>
  <div className="section-body">
    {/* dense content */}
  </div>
</section>
```

Visual spec:
- `background: var(--surface)` (near-opaque)
- `border: 1px solid var(--border)` (white-6% alpha)
- `border-radius: 12px`
- `box-shadow: inset 0 1px 0 var(--highlight), 0 1px 2px rgba(0,0,0,0.3)` — the inner top-highlight is the MetaMask signature
- `section-header`: 44px row, `border-bottom: 1px solid var(--border)`, title in `text-h2`, actions on the right
- `section-body`: padding 14px or 0 (if table fills it)

## Motion (restrained)

Motion is minimal and purposeful. No ambient animation. No auto-glow. No parallax.

**Allowed:**
- `fade-in` 220ms on data arrival.
- `cinematic-rise` 420ms only on *earned* moments — trade filled, agent decision.
- `number-pulse` 600ms when a tracked value updates.
- Ticker marquee, infinite linear.
- Hover: border `--border` → `--border-2`, 120ms.
- Drawer slide 240ms ease-out.

**Banned:**
- Ambient drifting glow (killed from the previous iteration).
- Bounce, overshoot, spring.
- Any `box-shadow` glow on buttons by default.
- Scanlines. Pulsing rings on non-status elements.
- Auto-rotating elements.

## Signature primitives (use; don't reinvent)

All in `globals.css`:

- `.section` / `.section-header` / `.section-title` / `.section-actions` / `.section-body`
- `.btn` / `.btn-primary` / `.btn-ghost` / `.btn-destructive` / `.btn-sm`
- `.input` / `.textarea` / `.select`
- `.chip` / `.chip-ok` / `.chip-warn` / `.chip-bad` / `.chip-accent` / `.chip-accent-2`
- `.stat-label` / `.stat-value` / `.stat-value-hero` / `.stat-delta` (with `.up` / `.down`)
- `.ticker-row` / `.ticker-item`
- `.table` — dense pro-table styling
- `.rail` / `.rail-item` — left icon rail
- `.statusbar` — top/bottom status strips
- `.drawer` — right chat drawer
- `.bubble` / `.bubble-user` / `.bubble-assistant`
- `.fade-in` / `.cinematic-rise` / `.number-pulse`
- `.live-dot` — green pulsing dot for "Live"

## Icons

- Product UI: inline SVG, 1.5px stroke, `stroke="currentColor"`, 16 or 18px.
- No emoji for product actions. Ever.
- OK to use geometric glyphs (`◉ ◆ ◈ ◐ ⟡`) sparingly as ornament only.
- Brand mark: qwai hexagon (see `app/icon.svg`), gradient reserved for this mark.

## Do / don't cheat-sheet

✅ DO
- Use `var(--token)` for every color, always.
- Treat numbers as typography — mono, `tnum`, right-aligned in tables.
- Give every card a header row + divider, even if the header is just a title.
- Show `loading` as skeletons matching the final shape, not spinners.
- Keep one primary action per view.
- Respect `prefers-reduced-motion`.

❌ DON'T
- Hardcode `#fff`, `#000`, `bg-gray-900`, `text-white`, `border-gray-800`.
- Use emoji for product UI.
- Add outer glow / neon to resting state elements.
- Mix blue + purple at equal weight — blue leads, purple supports.
- Invent new card shapes. Every card is `.section`.
- Use system serif. Use three fonts max.
- Pad things to 32px when 14-18px fits pro-dense.
- Center-align numbers in tables. Always right-align numerics.

## Workflow rule

For any non-trivial UI change: **update or reference `/design`** (the internal UI-kit page at `apps/web/app/design/page.tsx`) before touching real routes. If a new primitive is needed, add it to the kit first, get user approval, then roll into pages.

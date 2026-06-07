---
name: agentObserve
description: An observability instrument for AI agents — every span, every token, every tool decision, on one canonical surface.
colors:
  off-black:      "#0c0c0f"
  console-steel:  "#16161d"
  iron:           "#1a1a20"
  rule:           "#2a2a32"
  phosphor:       "#3dd68c"
  amber:          "#e0a040"
  wire:           "#58a6ff"
  halt:           "#e5534b"
  hook:           "#bc8cff"
  dim:            "#a4a4b3"
  muted:          "#c8c8d4"
  soft:           "#d4d4dc"
typography:
  display:
    fontFamily: "Geist, Inter, system-ui, sans-serif"
    fontSize: "19px"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-0.02em"
  title:
    fontFamily: "Geist, Inter, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 700
    lineHeight: 1.4
    letterSpacing: "normal"
  body:
    fontFamily: "Geist, Inter, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  mono-data:
    fontFamily: "JetBrains Mono, Fira Code, Cascadia Code, monospace"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
    fontFeature: '"tnum"'
  label:
    fontFamily: "Geist, Inter, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 500
    lineHeight: 1
    letterSpacing: "0.12em"
  rail:
    fontFamily: "Geist, Inter, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 500
    lineHeight: 1
    letterSpacing: "0.22em"
rounded:
  sm: "4px"
  md: "6px"
  lg: "8px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  "2xl": "32px"
components:
  session-row:
    backgroundColor: "{colors.off-black}"
    textColor: "{colors.wire}"
    typography: "{typography.mono-data}"
    padding: "8px 12px"
  session-row-hover:
    backgroundColor: "rgba(224, 160, 64, 0.06)"
  session-row-selected:
    backgroundColor: "rgba(61, 214, 140, 0.06)"
    textColor: "{colors.phosphor}"
  session-tab:
    backgroundColor: "transparent"
    textColor: "{colors.dim}"
    typography: "{typography.label}"
    padding: "6px 14px 8px"
    rounded: "{rounded.sm}"
  session-tab-active:
    backgroundColor: "{colors.off-black}"
    textColor: "{colors.amber}"
  panel-stepper:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    typography: "{typography.label}"
    padding: "3px 7px"
    rounded: "{rounded.sm}"
  panel-stepper-hover:
    backgroundColor: "rgba(224, 160, 64, 0.06)"
    textColor: "{colors.amber}"
  workflow-node:
    backgroundColor: "{colors.console-steel}"
    textColor: "{colors.soft}"
    typography: "{typography.body}"
    padding: "10px 16px"
    rounded: "{rounded.md}"
  workflow-node-hover:
    backgroundColor: "{colors.iron}"
  tool-decision-accept:
    backgroundColor: "rgba(61, 214, 140, 0.15)"
    textColor: "{colors.phosphor}"
    typography: "{typography.label}"
    padding: "1px 8px"
    rounded: "{rounded.sm}"
  tool-decision-block:
    backgroundColor: "rgba(229, 83, 75, 0.15)"
    textColor: "{colors.halt}"
    typography: "{typography.label}"
    padding: "1px 8px"
    rounded: "{rounded.sm}"
  tool-decision-unknown:
    backgroundColor: "rgba(82, 82, 94, 0.3)"
    textColor: "{colors.dim}"
    typography: "{typography.label}"
    padding: "1px 8px"
    rounded: "{rounded.sm}"
  hud-cell:
    backgroundColor: "{colors.console-steel}"
    textColor: "{colors.muted}"
    typography: "{typography.label}"
    padding: "8px 16px"
  cascade-node:
    backgroundColor: "{colors.console-steel}"
    textColor: "{colors.soft}"
    typography: "{typography.mono-data}"
    padding: "6px 8px"
    rounded: "{rounded.sm}"
---

# Design System: agentObserve

<!-- North Star is provisional — swap the line below if "The Observatory HUD" or "The Field Instrument" fits better in practice. -->

## 1. Overview

**Creative North Star: "The Forensic Console"**

agentObserve is the instrument an engineer sits at when something went wrong inside an agent run — and stays at when the run finished but the cost or the latency didn't match expectations. The visual system is built around that posture: an operator examining preserved evidence, not a dashboard performing for stakeholders. Every span is preserved. Every token is a number you can read. Every decision (a tool accept, a hook block, a stop reason) carries its semantic role in color, but the color is muted enough that you can stare at it for an hour without flinching.

The system commits to a terminal HUD aesthetic — off-black surfaces, mono numerals, panel-rail labels, semantic role colors borrowed from phosphor displays and indicator lamps. The commitment is **forensic, not theatrical**: the dungeon/terminal scaffolding is voice, not costume. CRT scanlines and decorative ASCII art are tolerated only when they sharpen rather than soften reading the data. The system explicitly rejects gamification (no XP bars, no confetti, no mascots), legacy enterprise observability (no AWS-Console-style clutter), and generic SaaS dashboard chrome (no indigo-and-slate cards-with-icons grids). It also rejects pure roguelike pastiche — turns are turns, not "rooms"; nodes are nodes, not "stat blocks".

**Key Characteristics:**
- Off-black surface, near-monochrome with **five role colors** (phosphor green, sodium amber, wire cyan, halt red, hook purple) — each color carries one meaning and no decoration.
- **Geist Sans + JetBrains Mono** pair. Mono for everything that is data; sans for labels, headers, and prose.
- **Phosphor glow** for elevation. No drop shadows. Depth is emission.
- **Mono numerals throughout** (`font-variant-numeric: tabular-nums`). Numbers align in columns by default.
- **Dense, calm, scannable.** 12-13px typography for data tables. Long sessions are the use case.
- **Panel-rail HUD vocabulary**: collapsed sidebars become vertical rail labels, not hamburger toggles.

## 2. Colors

A near-monochrome dark palette with five strictly semantic role colors. Surfaces are physical materials; accents are signals. No decorative color anywhere.

### Primary
- **Phosphor** (`#3dd68c`): the operational/success/active signal. Selected workflow nodes, active timeline segment, tool-accept badges, primary metric values, agent-kind border accents, copy-success confirmation. The signal that says *this is running / this is the one*. Treat as the project's brand accent.

### Secondary
- **Amber** (`#e0a040`): cost, duration, in-progress, attention-without-error. HUD turn counter, cost column, in-progress prompts, panel-stepper hover, session-tab active, scrollbar-thumb hover. The "watch this" color. Never used decoratively.
- **Wire** (`#58a6ff`): identifiers and structural links. Session IDs in the table, HUD session value, LLM-kind node borders, focus ring outlines. Borrowed from the universal "this is a link / this is an ID" convention; reads as identity-not-action.

### Tertiary
- **Halt** (`#e5534b`): errors, blocked tool decisions, failed hooks. Red is reserved exclusively for actually-bad outcomes — never for "info" or "destructive but normal".
- **Hook** (`#bc8cff`): hook-kind nodes, hook-event labels, thought blocks. The color of meta-machinery — the things that happen around the LLM call rather than the call itself.

### Neutral
- **Off-Black** (`#0c0c0f`): the canvas. App background, the default cell color in the session table.
- **Console Steel** (`#16161d`): one step up — HUD bar, sidebar bodies, session-tabs strip, workflow-node body, cascade-node body.
- **Iron** (`#1a1a20`): two steps up — workflow-node hover state, scaling sub-surfaces.
- **Rule** (`#2a2a32`): all 1px borders, dividers, table row separators, scrollbar track when needed.
- **Soft** (`#d4d4dc`): body text on dark surfaces. Cool-tinted near-white.
- **Muted** (`#c8c8d4`): secondary body text, default panel labels.
- **Dim** (`#a4a4b3`): tertiary text, table column heads, key/value keys, "not available" empty-state copy, scrollbar thumb.

### Named Rules

**The One-Meaning Rule.** Each of the five role colors carries exactly one meaning across the entire app. Phosphor is operational, Amber is attention, Wire is identity, Halt is error, Hook is meta. If a new state needs a color, find an existing role that fits — do not invent a sixth accent. New roles require explicit registration here first.

**The 10% Rule.** On any one screen, the combined ink of the five role colors should not exceed ~10% of the visible area. Most pixels are off-black, console-steel, and neutral text. Role colors earn their visibility by being rare.

**The No-Decoration Rule.** Color never communicates personality, mood, or brand "warmth". If a color is on the page, it is reporting state. Decorative tinted backgrounds (warm-cream, paper, sand) are categorically banned — this is an instrument, not a magazine.

## 3. Typography

**Display Font:** Geist (with Inter and system-ui fallbacks)
**Body Font:** Geist (single family; weight contrast carries the hierarchy)
**Label/Mono Font:** JetBrains Mono (with Fira Code, Cascadia Code fallbacks)

**Character:** Geist provides a precise, neutral, slightly technical sans that reads as an instrument's typeface — close in spirit to Inter but tighter on the apertures, with strong tabular numerals. JetBrains Mono is the canonical data face: every span ID, token count, duration, JSON payload, and prompt body uses it. The pairing is *one careful sans, one precise mono*; never a third family.

### Hierarchy
- **Display** (Geist, 600, 19px, line-height 1.3, letter-spacing -0.02em): top-of-page section title only — used today by `.session-list__header`. Sentence case.
- **Title** (Geist, 700, 14px, line-height 1.4): block headers inside panels — `.tool-header`, `.conv-block__header`, `.workflow-node__header`. Sentence case.
- **Body** (Geist, 400, 15px, line-height 1.5): the default. Used sparingly — most surfaces are dense data, not paragraphs. When body prose appears (system prompt panel, captured blocks), wrap to ≤72ch.
- **Mono Data** (JetBrains Mono, 400, 13px, tabular-nums): every numeric value, ID, timestamp, JSON payload, cell of the session table.
- **Label** (Geist, 500, 11px, letter-spacing 0.12em): HUD labels, panel headers, column heads. Uppercase by content — written `SESSION`, `TURN`, `TOKENS`, `DURATION`. **Not** `text-transform: uppercase` on body text. Keep ≤4 words.
- **Rail** (Geist, 500, 11px, letter-spacing 0.22em, vertical-rl): the collapsed-panel rail label. The widest tracking in the system; the only place writing-mode rotates.

### Named Rules

**The Two-Family Rule.** Geist and JetBrains Mono are the entire type system. No third typeface, no decorative display face for "moments", no all-caps wordmark using a third family. Hierarchy comes from weight, size, and the sans-vs-mono switch.

**The Mono-For-Data Rule.** If a value is a number, an ID, a duration, a token count, a JSON payload, or a path — it is JetBrains Mono with `font-variant-numeric: tabular-nums`. No exceptions. Sans-serif numbers in a data column are a bug.

**The Short-Label Rule.** Uppercase tracked labels are reserved for ≤4-word labels and HUD eyebrows (`SESSION`, `TOTAL TOKENS`). Sentences and prose stay in sentence case; uppercase body text is forbidden.

## 4. Elevation

The system has **no drop shadows**. Depth is conveyed in three ways, in priority order: (1) **tonal layering** between off-black, console-steel, and iron; (2) **1px rule borders** in `--rule` for structural separation; (3) **phosphor glow** — colored emission halos in the role color — as the response to selection and active state. This is the elevation philosophy of an instrument panel, not a paper interface.

### Glow Vocabulary

- **Selected Workflow Node** (`box-shadow: 0 0 0 1px <role-color>, 0 4px 12px rgba(<role-color>, 0.15)`): a 1px crisp ring in the node's role color plus a soft diffuse halo. The node looks like it's emitting, not floating.
- **Active Timeline Segment** (`box-shadow: 0 0 6px rgba(61, 214, 140, 0.5)`): pure phosphor halo; the segment glows like a lit indicator.
- **Selected Minimap Node** (`box-shadow: 0 0 5px <role-color>`): smaller halo for the smaller node.
- **Copy-Confirm State**: no shadow; color shift to phosphor for 1.5s.

### Named Rules

**The No-Shadow Rule.** Drop shadows are banned. `box-shadow` is used only for (a) inset/outline rings on selected states and (b) the colored emission halos described above. If a new component needs depth, layer it in surface tone (off-black → console-steel → iron) and add a 1px rule, not a shadow.

**The Glow-Equals-State Rule.** A glow on the page means a state is active. Glow is never decorative. If something glows that the user didn't select or activate, that is a bug.

## 5. Components

Every component is built from the same vocabulary: a tonal surface, a 1px rule border (optional), one role color carrying meaning, mono numerals when there's data. States transition in 150-220ms with `cubic-bezier(0.4, 0, 0.2, 1)` ease-out.

### Session Row (the entry surface)
- **Shape:** flat `<tr>` with a 1px `--rule` border bottom; no radius.
- **Default:** off-black background; wire-cyan ID column, dim date column, phosphor turns/tokens columns, amber cost column.
- **Hover:** background tints amber at 6% opacity. Cursor pointer.
- **Selected:** background tints phosphor at 6% opacity, plus a 3px phosphor inset rail on the left edge (the only left-stripe pattern in the system; see Don'ts).
- **Density:** 8px 12px padding; mono numerals throughout.

### Session Tab (framework filter)
- **Shape:** rounded-top-only (`var(--rounded.sm) var(--rounded.sm) 0 0`), no bottom radius — sits on a bottom rule.
- **Default:** transparent background, dim text, label typography (11px tracked).
- **Hover:** amber tint background (6%), text shifts toward muted.
- **Active:** off-black background ("cuts through" the bottom border), amber text, count badge bordered + colored in amber.

### Panel Stepper (collapse/expand controls)
- **Shape:** 1px `--rule` border, `--rounded.sm`.
- **Default:** transparent background, muted text, mono `«` / `»` glyphs.
- **Hover:** amber text + amber border + amber tint background at 6%.
- **Active:** `scale(0.94)` micro-press.
- **Disabled (`aria-disabled="true"`):** opacity 0.3, no hover response.

### Workflow Node (graph nodes)
- **Shape:** `var(--rounded.md)`, 1px `--rule` border + 3px **role-color left border** indicating node kind (cyan = LLM, phosphor = AGENT). The left-stripe pattern is the system's chosen way to encode semantic type; do not propagate to non-typed cards.
- **Default:** console-steel background, soft text in header, mono data row below (model · duration · tokens — colored by role).
- **Hover:** background shifts to iron; `translateY(-2px)` lift with ease-out-quart (`cubic-bezier(0.22, 1, 0.36, 1)`, exposed as `var(--ease-out)`). Never bounce/elastic — they feel dated.
- **Selected:** phosphor glow per the Elevation section.
- **Focus-visible:** 2px wire-cyan outline at 2px offset.

### Tool Decision Badge
- **Shape:** inline-block, `var(--rounded.sm)`, 1px border in the role color.
- **Variants:**
  - **Accept:** phosphor at 15% background, phosphor text + border, label "ACCEPT".
  - **Block:** halt at 15% background, halt text + border, label "BLOCK".
  - **Unknown:** dim at 30% background, dim text + border, label "UNKNOWN".

### HUD Cell (top status bar)
- **Shape:** flex row, left-bordered between cells with `--rule`. No radius.
- **Internal:** uppercase tracked label (11px, muted) + mono value (13px, role-colored — wire for IDs, phosphor for counts, amber for the turn counter).
- **Copyable variant:** session ID. Click → mono "copied" in phosphor for 1.5s, then back to wire.

### Cascade Node (LLM/Tool/Hook step in step panel)
- **Shape:** `var(--rounded.sm)`, 1px border in role color (phosphor/wire/hook).
- **Internal:** header (model + duration), mono input preview, mono output preview separated by a 1px `--rule` divider.

### Panel Rail (collapsed-state label)
- **Shape:** vertical text via `writing-mode: vertical-rl` + `rotate(180deg)`.
- **Style:** label typography at 0.22em tracking, uppercase by content (e.g. `SYSTEM PROMPT`, `TOOLS`).
- **Behavior:** only visible when the panel's data-attribute is `collapsed`.

### Scrollbar (WebKit)
- **Width:** 4px.
- **Track:** transparent.
- **Thumb:** dim by default, amber on hover. `var(--rounded.xs)` (2px).
- **Intentionally thin** — must not draw attention away from data.

### Named Rules

**The Phosphor-Glow Selection Rule.** Selected state on any component uses a colored ring + halo in that component's role color. Not a background fill, not a check mark, not an underline. If a component needs a selected state, it glows.

**The Tabular-Numeral Rule.** Every cell that holds a number must use `font-variant-numeric: tabular-nums`. Columns of numbers that don't line up are a quality bug.

## 6. Do's and Don'ts

### Do:
- **Do** keep the dungeon/terminal scaffolding (mono numerals, off-black, panel-rail vocabulary, phosphor accents). It is the project's voice; do not soften it toward generic SaaS-dark.
- **Do** use mono (`JetBrains Mono`) with `font-variant-numeric: tabular-nums` for every numeric value, ID, timestamp, JSON payload, or path.
- **Do** convey state with the role colors at low opacity backgrounds (6% / 15%) and full-opacity text/borders. The pattern in `.tool-decision--accept`, `.tool-decision--block`, `.tool-decision--unknown` is the canonical example.
- **Do** convey depth with tonal layering (`off-black` → `console-steel` → `iron`) and 1px `--rule` borders. Reach for `box-shadow` only for selection glows.
- **Do** put uppercase tracked labels on HUD cells, panel headers, and column heads — written uppercase, ≤4 words, never `text-transform: uppercase` on body content.
- **Do** test new screens at hour three of a long debugging session. If a color or motion gets tiring, it is wrong.
- **Do** treat the user as the expert. Surface `SESSION`, `TURN`, `STOP REASON`, `MODEL` directly; never paraphrase OTEL/SDK vocabulary into friendlier words.

### Don't:
- **Don't** introduce a sixth role color. Phosphor / Amber / Wire / Halt / Hook is the full palette. New states reuse existing roles.
- **Don't** use drop shadows. Depth = tonal layering + 1px borders + phosphor glow for selection. (**The No-Shadow Rule.**)
- **Don't** use gradient text (`background-clip: text` + gradient background). Anywhere.
- **Don't** add glassmorphism / backdrop-filter beyond the single existing `backdrop-filter: blur(8px)` on `.hud`. Decorative blur is forbidden.
- **Don't** add `border-left: Npx solid <color>` as a colored stripe on **new** cards or callouts. The pattern exists on `.workflow-node` and `.conv-block` because the stripe encodes semantic type/role; do not propagate it to surfaces that don't need it.
- **Don't** introduce warm-tinted neutrals (cream, paper, sand, parchment). This system is cool-leaning off-black; warm bg is categorically off-brand.
- **Don't** add a third font family. Geist + JetBrains Mono is the system. (**The Two-Family Rule.**)
- **Don't** gamify. No XP, no confetti, no mascot, no "Great job!" toasts. Anti-reference in PRODUCT.md: *Gamified / dashboard-as-arcade*.
- **Don't** clutter for completeness. Anti-reference in PRODUCT.md: *AWS Console / legacy enterprise observability*. Each cell on the page exists because it surfaces a span / token / cost / decision that the user couldn't see otherwise.
- **Don't** reach for generic SaaS chrome (indigo+slate, cards-with-icons grids, Stripe-style charts). agentObserve has its own voice. Anti-reference in PRODUCT.md: *Generic SaaS dashboard*.
- **Don't** lean into the dungeon-crawler metaphor. Turns are turns, sessions are sessions, nodes are nodes. Anti-reference in PRODUCT.md: *Roguelike-as-marketing*.
- **Don't** use em dashes in UI copy or labels. Use commas, colons, or periods.
- **Don't** use uppercase body text. Uppercase is reserved for ≤4-word labels and HUD eyebrows.
- **Don't** pair similar fonts. The system pairs Geist (humanist sans) with JetBrains Mono (geometric mono). Adding Inter, IBM Plex Sans, or any other humanist sans is forbidden.
- **Don't** animate layout properties (width, height, top, left). Use transform / opacity / box-shadow. The existing `grid-template-columns` transition on `.dungeon-view` is the documented exception (panel collapse/expand) and should not be propagated.

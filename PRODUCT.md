# Product

## Register

product

## Users

AI engineers, debug-first. The primary user is one engineer staring at one bad agent run, trying to answer: *why did the model pick that tool, why did the token count spike, why did the workflow stall on turn 4?* They're fluent in OTEL semantics, LangChain/LangGraph, and the Claude Agent SDK; they don't need translations of what a span or a tool-use block is.

Two secondary surfaces share the same UI:

- **Production monitoring** — engineers scanning recent sessions for cost spikes, latency regressions, or tool-call failures across many runs.
- **Research / exploration** — engineers running agent experiments who want to compare reasoning chains across runs and build intuition about model + tool behavior.

The UI ranks debug-first: a single bad session must be inspectable in seconds without filters or setup. Production and research are real audiences but their needs are met by the same canonical data shape, viewed differently — never by a separate "mode" toggle.

## Product Purpose

agentObserve renders OTEL telemetry from AI agent frameworks as a navigable record of what the agent actually did: every LLM call, tool decision, hook, sub-agent invocation, captured request/response body. It auto-detects the framework (LangChain/LangGraph, Anthropic SDK / Claude Agent SDK) and parses each session into one canonical schema so the same workflow graph and step panel work for all of them.

Success: an engineer opens a session, finds the failing turn within three keystrokes, sees the LLM call that caused it, and knows what to change in their agent code — without dropping back to raw JSON or scrolling protobuf.

## Brand Personality

**Calm. Surgical. Dependable.**

A working terminal HUD, not a dungeon-crawler costume. The dark surface, mono type, terminal palette, and HUD/panel-rail vocabulary are voice — they signal "this is a developer instrument, built by someone who respects your time and your screen." The theatrical layer (CRT scanlines, decorative ASCII boxes, color flashes used as garnish) is interrogated, not assumed; it earns its place only when it makes the data easier to read across a long session.

Voice in copy: short, direct, no marketing tone, no encouragement, no exclamation. Labels name the thing (`SESSION`, `TURN`, `TOKENS`, `DURATION`). Errors describe what failed and what to do about it. Empty states say what's missing and how to enable it (`not available — enable OTEL_LOG_RAW_API_BODIES`). The product treats the user as the expert.

Emotional goal: the user should feel they're using something that an engineer built carefully for engineers. Not friendly. Not flashy. Trusted.

## Anti-references

- **Gamified observability** — achievement badges, XP-style progress, animated confetti, mascot characters, "great job!" toasts, any move that infantilizes a debugging surface.
- **AWS Console / legacy enterprise observability** — cluttered dropdowns, inconsistent tables, hostile information hierarchy, color choices that fight the data.
- **Generic SaaS dashboard** (Stripe / Linear / Notion variants where the chrome is the personality) — indigo+slate, pastel chart palettes, cmd-K hero treatment, cards-with-icons grids. agentObserve has its own voice; it doesn't need to borrow theirs.
- **Roguelike-as-marketing** — leaning so hard into the dungeon metaphor that turns become "rooms," tool calls become "actions," and the HUD becomes a stat-block. The aesthetic exists to clarify the data, not narrate it.

## Design Principles

1. **Data over chrome.** Every panel, border, color, and font choice exists to make a number or a span or a decision easier to read. If a flourish doesn't aid the debugging task, cut it.
2. **Forensic, not theatrical.** The terminal aesthetic is the voice of an instrument, not a costume. Keep what reads as precise (mono numerals, tight tables, deliberate color roles, panel-rail HUD vocabulary); restrain what reads as decoration (CRT scanlines as a default, ASCII art repeated as a motif, garnish-color flashes).
3. **Long-session readability wins.** Users will live in this view for hours. Contrast, spacing, motion, and color all answer to: *does this stay comfortable on hour three?* When in doubt, calm down.
4. **Honor the operator.** Users know what spans, tools, tokens, and stop reasons are. Don't paraphrase domain terms into friendly language; surface the actual OTEL/SDK vocabulary and let it work.
5. **One canonical shape.** Three frameworks, three audiences, one schema, one workflow-graph + step-panel. Don't fork the UI into modes; let the same surface serve debug, monitoring, and research by ranking what's on screen, not by hiding things behind a switch.

## Accessibility & Inclusion

No formal WCAG target. Internal-feeling developer tool; aesthetic latitude is intentional.

Practical floor:
- Body text and labels should remain legible against their backgrounds at typical monitor brightness — bump muted grays toward the ink end of the ramp when contrast feels close. (Useful guide: 4.5:1 for body, 3:1 for large/bold.)
- Every keyboard-reachable control needs a visible focus state. The product leans on keyboard navigation; focus rings are not optional.
- `prefers-reduced-motion: reduce` should disable scanline overlays, panel-width transitions, and any decorative motion. Functional state changes can fall back to instant transitions.
- Don't carry semantic meaning by color alone — the green/amber/red role colors should always pair with a label, glyph, or shape.

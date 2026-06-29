# Changelog

All notable changes to agentObserve are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The release-notes section of each version is the source of truth for the
`manifest.json` asset attached to the corresponding GitHub Release.

## [Unreleased]

## [1.2.0] - 2026-06-29

### Added
- **See where your tokens actually go.** Every agent run now shows exact
  token usage broken down to the individual message and content block —
  thinking, text, tool calls, and final replies each carry their own
  count, summing precisely to the model's reported total. You can finally
  answer "what cost me the most in this turn?" at a glance.
- **Per-tool token cost.** Each tool call shows roughly how many tokens
  the model spent *writing* the call and how many it read back from the
  result, so expensive tools (large file reads, verbose search results)
  are easy to spot. Counts show an em dash rather than a misleading `0`
  when the underlying content wasn't captured.
- **Token-weighted timeline.** The per-turn timeline bar now sizes each
  step by its token volume, not just its duration — a fast but
  token-heavy step is no longer visually hidden behind a slow, cheap one.
- **Collapsible message blocks.** Long messages within an LLM call collapse
  by default and expand on click, so a turn with large prompts or outputs
  stays scannable. Your expand/collapse choices now persist as you move
  around the agent view instead of resetting each time.
- **Tool sidebar jumps to every call site.** Clicking a tool in the
  sidebar now cycles through *all* of its call sites in the cascade — not
  just the first — with a position readout (e.g. `2/5`) so you can walk
  every place a tool was used.

### Fixed
- **Sessions no longer scatter into "unknown."** Runs whose telemetry
  arrives as cost/usage metrics (Claude Code and the Anthropic SDK) are
  now grouped under the correct session instead of landing in an
  `unknown` bucket, so a single agent run shows up as one session.

### Upgrade notes
- This release is fully backward-compatible — **no changes to the
  instrumentation you install in your agent project** and no new
  environment variables. Just pull the latest server, reinstall server
  dependencies, and restart the stack.
- Docker users: `docker compose pull && docker compose up -d`.
- From-source users: after pulling, run `npm install` (a new dependency
  was added for token counting) and restart the services.

## [1.1.0] - 2026-06-11

### Added
- **Tool sidebar doubles as cascade navigation.** In the agent detail
  view, clicking a called tool's name scrolls the cascade to that
  tool's next call and cycles through occurrences (1 → N → 1) with a
  transient `2/5` position readout in the row. The target card flashes
  a phosphor ring that fades over 1.5s. Occurrences inside a parallel
  carousel are revealed (the carousel switches to that member) before
  scrolling. The schema toggle moved to a dedicated chevron button
  with a larger hit target; unused tools keep name-click as the schema
  toggle. Honors `prefers-reduced-motion` (instant jump, static ring).
- **Wrap-aware collapse counts.** Collapsible text blocks estimate
  visual rows instead of counting newlines, so single-line minified
  JSON no longer renders hundreds of rows before the fold. Estimated
  counts are marked with `~`.
- **Pretty-printed JSON output.** Tool results and sub-agent responses
  that contain JSON are pretty-printed via shared `prettyJson` utils.

### Fixed
- **Receiver no longer drops session resolution on metrics-only
  payloads.** Metric records carry attributes on their data points,
  not the record itself; the receiver now guards the lookup.
- **Raw API body refs resolve across host/container boundaries.**
  `body_ref` paths are rewritten against `telemetry/<session>/api_bodies/`
  before falling back to the literal path, and the receiver container
  mounts `/tmp/agentobserve_bodies` so host-written bodies reach it.

## [1.0.1] - 2026-06-08

### Fixed
- **Update checker bypasses GitHub's CDN cache.** v1.0.0 fetched
  `manifest.json` via `asset.browser_download_url`, which is served by
  a CDN that caches even with `cache-control: no-cache`. If a manifest
  is replaced after publish (via `gh release upload --clobber`), the
  CDN can serve the stale payload to dashboards for hours. The
  checker now uses the REST asset endpoint (`asset.url` with
  `Accept: application/octet-stream`), which returns the current
  asset content directly — fixes propagate immediately.
- **Release workflow's urgency marker no longer matches prose.** The
  regex was `urgency:\s*critical` against the whole CHANGELOG section,
  which fired on any sentence describing the marker itself (caught
  during the v1.0.0 cut). Now requires `<!-- urgency: critical -->`
  alone on its own line — invisible in rendered release notes and
  isolated from documentation prose.

### Note on v1.0.0
The v1.0.0 `manifest.json` was briefly published with `upgradeUrgency:
critical` because the original regex matched the phrase explaining
what the marker does. The asset has been re-uploaded with the
correct `recommended` urgency, but dashboards that polled GitHub
during the window may have seen a non-dismissible banner. The
v1.0.1 fix above ensures subsequent post-publish fixes propagate
without CDN delay.

## [1.0.0] - 2026-06-08

### Added — v1.0.0 highlights

v1.0.0 promotes [1.0.0-rc.2](#100-rc2---2026-06-08) (legal foundation +
Docker stack + release pipeline) to stable and adds:

- **Update awareness.** The API service polls GitHub Releases on
  startup and exposes the result at `GET /api/version`. The dashboard
  renders a dismissible "vX.Y.Z available" banner with the one-line
  upgrade command. Dismissals are per-version (dismissing v1.3 doesn't
  suppress v1.4). Critical releases (banner non-dismissible) are opted
  in per-release by adding an `<!-- urgency: critical -->` HTML comment
  to the CHANGELOG section. The check is opt-out via
  `AGENTOBSERVE_UPDATE_SOURCE=disabled` and falls back silently on
  network failure. Result is cached to `<data>/.update_cache.json`
  for 6h so the dashboard never hammers GitHub.
- **Two-part README quickstart.** Part A boots the dashboard in
  three bash lines (Docker prereq only). Part B is three self-
  contained instrumentation paths — LangChain / LangGraph, Anthropic
  SDK / Claude Agent SDK, raw `claude` CLI — each standalone, no
  cross-references between them, drops the `mkdir -p .claude` step,
  drops the PyPI claim (SDK is local-install in v1).

With v1.0.0, the four-year BSL clock for this version starts ticking.
On the Change Date, v1.0.0 (and only this version) auto-converts to
Apache License 2.0 per `LICENSE`.

## [1.0.0-rc.2] - 2026-06-08

### Added
- BSL 1.1 LICENSE, COPYRIGHT, NOTICE, and per-file copyright headers
  establishing Rishu Goyal as Licensor of agentObserve. Each version
  auto-converts to Apache-2.0 four years after its publication date.
- `VERSION` file at repo root — single source of truth for all published
  artifacts (Docker images, release manifest).
- `MIN_SUPPORTED_VERSION` file driving the dashboard update banner's
  "critical urgency" gate.
- `CHANGELOG.md` following Keep-a-Changelog; the matching version section
  is extracted as GitHub Release notes and feeds the urgency field of
  `manifest.json`.
- `scripts/add-license-headers.sh` idempotently applies copyright headers
  across the codebase with `--check` (CI gate) and `--dry-run` modes.

### Changed — Docker-first distribution
- The server stack now ships as 3 container images
  (`ghcr.io/photon48/agentobserve-{receiver,api,ui}`). A new user goes
  from `git clone` to a running dashboard with `docker compose up -d` —
  no Node, Python, or `uv` prereqs.
- `server/index.js` now reads `TELEMETRY_DIR` from the environment so
  containers can mount the host's `./telemetry/` at `/data`. Falls back
  to `../telemetry` for non-Docker dev.
- `Makefile` removed. Old `make start/stop/restart/status/logs` are
  documented as `docker compose` equivalents in the README.
- `docker-compose.dev.yml` provides hot reload (bind-mounted source,
  `node --watch`, `uvicorn --reload`, vite dev server) for contributors.

### Changed — Release pipeline
- `.github/workflows/release.yml` builds linux/amd64 + linux/arm64
  images on each `v*` tag, pushes to GHCR, generates `manifest.json`
  from `VERSION` + `MIN_SUPPORTED_VERSION` + CHANGELOG urgency marker,
  extracts the matching CHANGELOG section as Release notes, and creates
  the GitHub Release with `manifest.json` attached.
- `.github/workflows/ci.yml` runs `add-license-headers.sh --check` and
  builds all 3 images on every PR (no push).
- `scripts/release.sh` is the one-command release entry: bumps VERSION,
  rotates CHANGELOG `[Unreleased]` → `[X.Y.Z] - YYYY-MM-DD`, commits,
  tags, pushes.

### Fixed
- `uv.lock` is now tracked. It was previously gitignored, which broke
  reproducible receiver image builds in CI (the local build worked only
  because the file existed on disk).

## [0.0.0] - 2026-06-07

### Added
- Initial undocumented internal-development snapshot prior to packaging work.
  Not published; recorded for changelog continuity only.

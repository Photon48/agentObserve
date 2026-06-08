# Changelog

All notable changes to agentObserve are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The release-notes section of each version is the source of truth for the
`manifest.json` asset attached to the corresponding GitHub Release.

## [Unreleased]

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

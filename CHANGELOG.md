# Changelog

All notable changes to agentObserve are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The release-notes section of each version is the source of truth for the
`manifest.json` asset attached to the corresponding GitHub Release.

## [Unreleased]

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

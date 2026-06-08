# Changelog

All notable changes to agentObserve are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The release-notes section of each version is the source of truth for the
`manifest.json` asset attached to the corresponding GitHub Release.

## [Unreleased]

## [1.0.0-rc.1] - 2026-06-08

### Added
- BSL 1.1 LICENSE, COPYRIGHT, NOTICE, and per-file copyright headers establishing
  Rishu Goyal as the Licensor of agentObserve. License converts to Apache-2.0
  four years after each version is published.
- Top-level `VERSION` file as the single source of truth for all published
  artifacts (Docker images, PyPI package, release manifest).
- `CHANGELOG.md` driving the release-notes pipeline.
- Helper script `scripts/add-license-headers.sh` to apply the standard 5-line
  copyright header across the codebase.

### Planned for 0.1.0 → 1.0.0 (see plan)
- Monorepo restructure into `packages/{shared,receiver,api,ui,sdk}/`.
- Docker Compose distribution; images published to GHCR.
- GitHub Actions release pipeline (`amd64`+`arm64` images, PyPI publish, manifest asset).
- Update-check via GitHub Releases + UI banner.
- `agentobserve-env claude` SDK command with project/user/shell scope installers.

## [0.0.0] - 2026-06-07

### Added
- Initial undocumented internal-development snapshot prior to packaging work.
  Not published; recorded for changelog continuity only.

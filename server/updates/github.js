// Copyright (c) 2026 Rishu Goyal. All rights reserved.
// Licensed under the Business Source License 1.1.
// See LICENSE in the project root for license terms.
//
// GitHub Releases update source. v1 implementation of the checker
// interface. Fetches the latest release for GITHUB_REPO (default
// Photon48/agentObserve), downloads the attached manifest.json asset
// for richer fields (urgency, flags, min-supported), and caches the
// raw manifest to disk for 6 hours so the dashboard doesn't hammer
// GitHub on every page load.

import fs from 'fs';
import path from 'path';
import { compareVersions } from './checker.js';

const REPO = process.env.GITHUB_REPO ?? 'Photon48/agentObserve';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h

const DEFAULT_UPGRADE_COMMAND = 'docker compose pull && docker compose up -d';
const FETCH_TIMEOUT_MS = 5000;

export class GitHubChecker {
  constructor() {
    const dataDir = process.env.TELEMETRY_DIR ?? './telemetry';
    this.cachePath = path.join(dataDir, '.update_cache.json');
  }

  async getLatest(currentVersion) {
    const manifest = this.readCache() ?? (await this.fetchAndCache());
    if (!manifest) return null;
    return formatResult(currentVersion, manifest);
  }

  readCache() {
    try {
      const stat = fs.statSync(this.cachePath);
      if (Date.now() - stat.mtimeMs > CACHE_TTL_MS) return null;
      return JSON.parse(fs.readFileSync(this.cachePath, 'utf8'));
    } catch {
      return null;
    }
  }

  async fetchAndCache() {
    const manifest = await fetchLatestManifest();
    if (manifest) {
      try {
        fs.writeFileSync(this.cachePath, JSON.stringify(manifest));
      } catch {
        // Non-fatal — if we can't write the cache we'll just refetch next time.
      }
    }
    return manifest;
  }
}

async function fetchLatestManifest() {
  // /releases/latest excludes prereleases. Until there's a stable release we
  // fall back to the most-recent of all releases so dev/rc installs still
  // see something useful.
  const release = (await fetchJSON(`https://api.github.com/repos/${REPO}/releases/latest`))
    ?? (await fetchLatestAnyRelease());
  if (!release) return null;

  const asset = (release.assets ?? []).find((a) => a.name === 'manifest.json');
  if (asset) {
    // Use the REST asset URL (asset.url) with octet-stream Accept instead of
    // browser_download_url. The browser URL goes through a CDN that caches
    // even with `cache-control: no-cache`, which means a fix uploaded via
    // `gh release upload --clobber` can be invisible to dashboards for hours.
    // The REST endpoint returns the fresh asset content directly.
    const manifest = await fetchJSON(asset.url, {
      Accept: 'application/octet-stream',
    });
    if (manifest) return manifest;
  }

  // Asset missing or download failed — synthesize a minimal manifest from
  // the release metadata so the dashboard at least surfaces "new release".
  return {
    version: release.tag_name?.replace(/^v/, ''),
    upgradeUrgency: 'recommended',
    releaseNotesUrl: release.html_url,
    upgradeCommand: DEFAULT_UPGRADE_COMMAND,
    flags: {},
  };
}

async function fetchLatestAnyRelease() {
  const list = await fetchJSON(`https://api.github.com/repos/${REPO}/releases?per_page=1`);
  return Array.isArray(list) && list.length > 0 ? list[0] : null;
}

async function fetchJSON(url, extraHeaders = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'agentObserve-update-check',
        Accept: 'application/vnd.github+json',
        ...extraHeaders,
      },
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function formatResult(currentVersion, manifest) {
  const latest = manifest.version;
  const hasUpdate = latest && compareVersions(latest, currentVersion) > 0;
  return {
    current: currentVersion,
    latest: latest ?? null,
    hasUpdate: Boolean(hasUpdate),
    urgency: manifest.upgradeUrgency ?? 'recommended',
    upgradeCommand: manifest.upgradeCommand ?? DEFAULT_UPGRADE_COMMAND,
    releaseNotesUrl: manifest.releaseNotesUrl ?? null,
    minSupportedVersion: manifest.minSupportedVersion ?? null,
    flags: manifest.flags ?? {},
  };
}

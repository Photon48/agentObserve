// Copyright (c) 2026 Rishu Goyal. All rights reserved.
// Licensed under the Business Source License 1.1.
// See LICENSE in the project root for license terms.
//
// Update-check facade. Selects the underlying implementation via
// AGENTOBSERVE_UPDATE_SOURCE (default `github`). Setting it to `disabled`
// short-circuits to null so the dashboard never nags and Express never
// reaches out to the network.
//
// Forward-compatible: Phase 6 will add `endpoint.js` for the hosted
// update.agentobserve.dev source. Existing installs keep `github`; new
// releases flip the default. No reinstall needed.

import { GitHubChecker } from './github.js';

// `||` (not `??`): docker compose passes empty strings for unset shell env
// vars, and `'' ?? 'github'` would mistakenly treat that as "user picked
// empty string" and refuse to run the check.
const SOURCE = process.env.AGENTOBSERVE_UPDATE_SOURCE || 'github';

const implementations = {
  github: () => new GitHubChecker(),
  // endpoint: () => new EndpointChecker(),   // Phase 6
};

/**
 * Resolve "what's the latest released version?" for a given current version.
 * Returns null on disable, unknown source, or network failure — callers
 * should treat null as "no update info available, render nothing".
 */
export async function checkForUpdates(currentVersion) {
  if (SOURCE === 'disabled') return null;

  const factory = implementations[SOURCE];
  if (!factory) {
    console.warn(
      `[agentObserve] unknown AGENTOBSERVE_UPDATE_SOURCE=${SOURCE}; skipping update check`,
    );
    return null;
  }

  try {
    return await factory().getLatest(currentVersion);
  } catch (e) {
    console.warn(`[agentObserve] update check failed: ${e.message}`);
    return null;
  }
}

/**
 * Numeric compare of two semver-ish strings. Returns -1 / 0 / 1.
 * Handles X.Y.Z plus optional -rc.N / -alpha.N / -beta.N pre-release tail
 * (per release.sh's validation regex). A pre-release sorts BEFORE the
 * matching stable version, and alpha < beta < rc.
 */
export function compareVersions(a, b) {
  if (a === b) return 0;
  const [aBase, aTail] = a.split('-', 2);
  const [bBase, bTail] = b.split('-', 2);

  const ap = aBase.split('.').map(Number);
  const bp = bBase.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((ap[i] ?? 0) > (bp[i] ?? 0)) return 1;
    if ((ap[i] ?? 0) < (bp[i] ?? 0)) return -1;
  }

  // Bases equal — a stable beats any pre-release.
  if (!aTail && bTail) return 1;
  if (aTail && !bTail) return -1;
  if (!aTail && !bTail) return 0;

  // Both pre-release — compare channel rank then numeric tail.
  const rank = { alpha: 0, beta: 1, rc: 2 };
  const [aChan, aNumStr] = aTail.split('.');
  const [bChan, bNumStr] = bTail.split('.');
  const ar = rank[aChan] ?? -1;
  const br = rank[bChan] ?? -1;
  if (ar !== br) return ar > br ? 1 : -1;
  const an = Number(aNumStr ?? 0);
  const bn = Number(bNumStr ?? 0);
  if (an !== bn) return an > bn ? 1 : -1;
  return 0;
}

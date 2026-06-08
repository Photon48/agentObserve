// Copyright (c) 2026 Rishu Goyal. All rights reserved.
// Licensed under the Business Source License 1.1.
// See LICENSE in the project root for license terms.
//
// Renders a dismissible "v X.Y.Z available — upgrade with …" strip at the
// top of the dashboard. Reads /api/version. Dismissal is localStorage
// scoped by the latest-version string so dismissing v1.3 doesn't suppress
// v1.4. urgency=`critical` overrides the dismiss button entirely.

import { useEffect, useState } from 'react';

const DISMISS_KEY_PREFIX = 'agentobserve:dismissed-update:';

export function UpdateBanner() {
  const [info, setInfo] = useState(null);
  const [dismissedKey, setDismissedKey] = useState(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/version')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        setInfo(data);
        if (data.latest) {
          setDismissedKey(localStorage.getItem(DISMISS_KEY_PREFIX + data.latest));
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  if (!info || !info.hasUpdate || !info.latest) return null;

  const isCritical = info.urgency === 'critical';
  if (dismissedKey && !isCritical) return null;

  const handleDismiss = () => {
    localStorage.setItem(DISMISS_KEY_PREFIX + info.latest, '1');
    setDismissedKey('1');
  };

  return (
    <div
      className={`update-banner update-banner--${isCritical ? 'critical' : 'recommended'}`}
      role="status"
      aria-live="polite"
    >
      <span className="update-banner__icon" aria-hidden="true">↑</span>
      <span className="update-banner__text">
        <strong>v{info.latest}</strong> available
        {info.current ? <span className="update-banner__current"> (you’re on v{info.current})</span> : null}
      </span>
      <code className="update-banner__cmd" title="Upgrade command">{info.upgradeCommand}</code>
      {info.releaseNotesUrl ? (
        <a
          className="update-banner__notes"
          href={info.releaseNotesUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          release notes ↗
        </a>
      ) : null}
      {!isCritical ? (
        <button
          type="button"
          className="update-banner__dismiss"
          onClick={handleDismiss}
          aria-label={`Dismiss v${info.latest} update notice`}
        >
          ×
        </button>
      ) : null}
    </div>
  );
}

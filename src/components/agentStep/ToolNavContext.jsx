// Copyright (c) 2026 Rishu Goyal. All rights reserved.
// Licensed under the Business Source License 1.1.
// See LICENSE in the project root for license terms.
import { createContext, useContext, useEffect, useRef } from 'react';

// Sidebar → cascade tool navigation. Mounted tool occurrences (ToolPair,
// OrphanToolUseBlock, ParallelCarousel members) register themselves; the
// sidebar's ToolRow calls navigate(toolName) to scroll the top stacked
// panel to the next occurrence, cycling 1 → N → 1.
//
// The context value is identity-stable (all mutable state lives in refs,
// the flash is direct DOM class manipulation) so registrations and
// navigations never re-render the cascade — PanelLayer's memoization
// stays intact.

export const NOOP_NAV = {
  register: () => () => {},
  navigate: () => null,
};

export const ToolNavContext = createContext(NOOP_NAV);

let nextEntryId = 1;

const FLASH_CLASS = 'tool-nav-flash';
const FLASH_MS = 1600;

function prefersReducedMotion() {
  return typeof window !== 'undefined'
    && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

export function ToolNavProvider({ children }) {
  const registryRef = useRef(new Map()); // id → { id, toolName, getEl, reveal, memberIdx }
  // Cycle memory: which occurrence the last navigate() landed on, plus a
  // signature of the visible entry set so any scope change (zoom in/out,
  // node/turn switch) restarts the cycle at occurrence 1.
  const cycleRef = useRef({ toolName: '', signature: '', idx: -1 });
  const flashRef = useRef({ el: null, timer: null });
  const valueRef = useRef(null);

  if (!valueRef.current) {
    const registry = registryRef.current;

    const clearFlash = () => {
      const f = flashRef.current;
      if (f.timer) clearTimeout(f.timer);
      f.el?.classList.remove(FLASH_CLASS);
      f.el = null;
      f.timer = null;
    };

    const flash = (el) => {
      clearFlash();
      el.classList.remove(FLASH_CLASS);
      void el.offsetWidth; // restart the fade animation if re-targeting fast
      el.classList.add(FLASH_CLASS);
      flashRef.current = {
        el,
        timer: setTimeout(() => {
          el.classList.remove(FLASH_CLASS);
          flashRef.current = { el: null, timer: null };
        }, FLASH_MS),
      };
    };

    const register = (entry) => {
      const id = nextEntryId++;
      registry.set(id, { ...entry, id });
      return () => registry.delete(id);
    };

    const navigate = (toolName) => {
      if (!toolName) return null;
      // Only elements inside the TOP stacked panel are valid targets —
      // lower zoom layers stay mounted underneath.
      const visible = [];
      for (const entry of registry.values()) {
        if (entry.toolName !== toolName) continue;
        const el = entry.getEl?.();
        if (!el || !el.closest('.stacked-panel--top')) continue;
        visible.push({ entry, el });
      }
      if (visible.length === 0) return null;

      visible.sort((a, b) => {
        if (a.el === b.el) return (a.entry.memberIdx || 0) - (b.entry.memberIdx || 0);
        return a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
      });

      const signature = visible.map((v) => v.entry.id).join(',');
      const cycle = cycleRef.current;
      const target =
        cycle.toolName === toolName && cycle.signature === signature
          ? (cycle.idx + 1) % visible.length
          : 0;
      cycleRef.current = { toolName, signature, idx: target };

      const { entry, el } = visible[target];
      entry.reveal?.();
      // Two frames: a carousel reveal remounts its member (key={idx}) and
      // runs its own rAF-deferred height measurement before layout settles.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          el.scrollIntoView({
            behavior: prefersReducedMotion() ? 'auto' : 'smooth',
            block: 'center',
          });
          flash(el);
        });
      });

      return { idx: target + 1, total: visible.length };
    };

    valueRef.current = { register, navigate };
  }

  return (
    <ToolNavContext.Provider value={valueRef.current}>
      {children}
    </ToolNavContext.Provider>
  );
}

export function useToolNav() {
  return useContext(ToolNavContext);
}

// Registers one mounted occurrence of `toolName` anchored at `elRef`.
// Inert under NOOP_NAV (e.g. inside a ParallelCarousel frame, where the
// carousel registers its members itself).
export function useToolOccurrence(toolName, elRef, { disabled = false } = {}) {
  const nav = useContext(ToolNavContext);
  useEffect(() => {
    if (disabled || !toolName || nav === NOOP_NAV) return undefined;
    return nav.register({
      toolName,
      getEl: () => elRef.current,
      memberIdx: 0,
    });
  }, [nav, toolName, disabled, elRef]);
}

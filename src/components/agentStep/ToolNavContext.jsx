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
      const inTop = (el) => !!(el && el.closest('.stacked-panel--top'));

      // Two kinds of entry contribute. Block-fallback entries are registered by
      // MessageCall and are ALWAYS present (one per tool call site, whether the
      // LLM call is expanded or collapsed) — they define the complete, ordered
      // occurrence list. Precise entries (ToolPair / carousel members) exist
      // only while their call is expanded and pinpoint the exact tool card to
      // scroll/pulse.
      const blocks = []; // { entry, el } — block-fallback, complete set
      const precise = new Map(); // occurrenceId → { entry, el }
      const loosePrecise = []; // precise entries without an occurrenceId
      for (const entry of registry.values()) {
        if (entry.toolName !== toolName) continue;
        const el = entry.getEl?.();
        if (!inTop(el)) continue;
        if (entry.blockFallback) blocks.push({ entry, el });
        else if (entry.occurrenceId) precise.set(entry.occurrenceId, { entry, el });
        else loosePrecise.push({ entry, el });
      }

      // An occurrence resolves to a TOOL-mode target (precise card, with its
      // reveal) when its call is open and the precise entry is mounted, else a
      // BLOCK-mode target (the .msg-call section, no reveal — we pulse the
      // collapsed LLM block rather than expanding it). `order`/`memberIdx` drive
      // a stable document-order sort; `key` is the cycle-stable identity.
      let occ;
      if (blocks.length) {
        occ = blocks.map(({ entry, el }) => {
          const open = entry.isOpen ? entry.isOpen() : true;
          const p = entry.occurrenceId ? precise.get(entry.occurrenceId) : null;
          const tool = open && p;
          return {
            target: tool ? p : { entry, el },
            order: el,
            memberIdx: entry.memberIdx || 0,
            key: entry.occurrenceId || entry.id,
          };
        });
      } else {
        // No block entries (e.g. the always-open lead group) — fall back to the
        // mounted precise entries directly.
        occ = [...precise.values(), ...loosePrecise].map(({ entry, el }) => ({
          target: { entry, el },
          order: el,
          memberIdx: entry.memberIdx || 0,
          key: entry.occurrenceId || entry.id,
        }));
      }
      if (occ.length === 0) return null;

      occ.sort((a, b) => {
        if (a.order === b.order) return a.memberIdx - b.memberIdx;
        return a.order.compareDocumentPosition(b.order) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
      });

      // Signature keyed on occurrence identity (not open/closed mode) so the
      // cycle position survives expanding/collapsing a call mid-sequence.
      const signature = occ.map((o) => o.key).join(',');
      const cycle = cycleRef.current;
      const target =
        cycle.toolName === toolName && cycle.signature === signature
          ? (cycle.idx + 1) % occ.length
          : 0;
      cycleRef.current = { toolName, signature, idx: target };

      const { target: chosen } = occ[target];
      chosen.entry.reveal?.();
      // Two frames: a carousel reveal remounts its member (key={idx}) and
      // runs its own rAF-deferred height measurement before layout settles.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          chosen.el.scrollIntoView({
            behavior: prefersReducedMotion() ? 'auto' : 'smooth',
            block: 'center',
          });
          flash(chosen.el);
        });
      });

      return { idx: target + 1, total: occ.length };
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
export function useToolOccurrence(toolName, elRef, { disabled = false, occurrenceId } = {}) {
  const nav = useContext(ToolNavContext);
  useEffect(() => {
    if (disabled || !toolName || nav === NOOP_NAV) return undefined;
    return nav.register({
      toolName,
      occurrenceId,
      getEl: () => elRef.current,
      memberIdx: 0,
    });
  }, [nav, toolName, disabled, occurrenceId, elRef]);
}

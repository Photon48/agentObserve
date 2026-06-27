// Copyright (c) 2026 Rishu Goyal. All rights reserved.
// Licensed under the Business Source License 1.1.
// See LICENSE in the project root for license terms.
import { createContext, useCallback, useContext, useState } from 'react';

// Persistent expand/collapse store for the agent view. Holds a Map keyed by a
// stable element id (a tool's toolUseId, a text block's render key, …) so a
// card's open state and each CollapsibleText's expanded state survive the two
// ways the agent view tears a node's subtree down and rebuilds it:
//   • a parallel carousel swapping siblings — only the active member is mounted,
//     so leaving and returning otherwise remounts it in its default state
//   • an LLM MessageCall collapsing then re-expanding — its body unmounts
// The store lives for the lifetime of one AgentStep and is reset when the step
// changes (see AgentStep in StepPanel.jsx), so expansion never leaks across
// steps. A null context (component used outside the provider) makes the hook
// behave exactly like a plain local useState.
export const ExpansionContext = createContext(null);

// [value, setValue] toggle that mirrors useState but, when an ExpansionContext
// and a non-null key are present, seeds from and writes through to the shared
// store. Each consumer keeps its own local state synced from the store on mount,
// so there is no global re-render and concurrently-mounted consumers never
// fight (keys are unique per element). setValue accepts a value or an updater
// fn, matching useState.
export function usePersistentToggle(key, initial = false) {
  const store = useContext(ExpansionContext);
  const [val, setVal] = useState(() =>
    store && key != null && store.has(key) ? store.get(key) : initial,
  );
  const set = useCallback(
    (next) => {
      setVal((prev) => {
        const resolved = typeof next === 'function' ? next(prev) : next;
        if (store && key != null) store.set(key, resolved);
        return resolved;
      });
    },
    [store, key],
  );
  return [val, set];
}

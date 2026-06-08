// Copyright (c) 2026 Rishu Goyal. All rights reserved.
// Licensed under the Business Source License 1.1.
// See LICENSE in the project root for license terms.
import { useRef, useState, useLayoutEffect, useCallback } from 'react';

export function useNodePositions() {
  const containerRef = useRef(null);
  const nodeRefs = useRef(new Map());
  const [positions, setPositions] = useState(new Map());

  const registerNodeRef = useCallback((gIdx, nIdx) => {
    const key = `g${gIdx}-n${nIdx}`;
    return (el) => {
      if (el) {
        nodeRefs.current.set(key, el);
      } else {
        nodeRefs.current.delete(key);
      }
    };
  }, []);

  const measure = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const cRect = container.getBoundingClientRect();
    const next = new Map();
    nodeRefs.current.forEach((el, key) => {
      const r = el.getBoundingClientRect();
      next.set(key, {
        topCenterX: r.left + r.width / 2 - cRect.left,
        topCenterY: r.top - cRect.top,
        bottomCenterX: r.left + r.width / 2 - cRect.left,
        bottomCenterY: r.top + r.height - cRect.top,
      });
    });
    setPositions(next);
  }, []);

  useLayoutEffect(() => {
    measure();
    const container = containerRef.current;
    if (!container) return;
    const ro = new ResizeObserver(measure);
    ro.observe(container);
    return () => ro.disconnect();
  }, [measure]);

  return { containerRef, positions, registerNodeRef, measure };
}

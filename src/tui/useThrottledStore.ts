import { useEffect, useReducer } from 'react';
import type { Store } from '../app/store.js';

/**
 * Re-render at a bounded rate.
 *
 * Ink re-renders and re-diffs the whole tree on every state change. A transfer updates
 * its byte counter thousands of times a second, so rendering per update would spend more
 * CPU drawing the download than receiving it. Instead the store marks itself dirty and
 * this hook samples it; `alwaysTick` covers transfer progress, which deliberately does
 * not mark the store dirty at all.
 */
export function useThrottledStore(store: Store, alwaysTick: boolean, hz = 8): void {
  const [, force] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    let dirty = false;
    const unsubscribe = store.subscribe(() => {
      dirty = true;
    });

    const timer = setInterval(() => {
      if (dirty || alwaysTick) {
        dirty = false;
        force();
      }
    }, Math.max(1, Math.round(1000 / hz)));

    return () => {
      unsubscribe();
      clearInterval(timer);
    };
  }, [store, alwaysTick, hz]);
}

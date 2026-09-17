import { useEffect, useState } from "react";

/**
 * Trails `value` by `ms`, so typing in a search box produces one request after
 * the user pauses rather than one per keystroke. The input itself stays
 * un-debounced and fully responsive; only the fetch waits.
 */
export function useDebounced<T>(value: T, ms = 250): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);

  return debounced;
}

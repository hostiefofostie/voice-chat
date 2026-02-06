/**
 * Simple debounce utility.
 *
 * Returns a debounced version of `fn` that delays invocation until `delayMs`
 * milliseconds have elapsed since the last call. The returned function also
 * exposes a `.cancel()` method to clear the pending timer.
 *
 * Intended usage:
 *  - Config changes (e.g. slider adjustments): debounce 1000ms to batch rapid changes
 *  - Rapid send prevention: debounce 500ms on the send action in the main screen
 */
export function debounce<T extends (...args: unknown[]) => void>(
  fn: T,
  delayMs: number,
): T & { cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const debounced = (...args: unknown[]) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delayMs);
  };

  debounced.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  return debounced as T & { cancel: () => void };
}

/** Recommended debounce delays (ms). */
export const DEBOUNCE_DELAYS = {
  /** Batch rapid config/slider changes before sending to server. */
  CONFIG_CHANGE: 1000,
  /** Prevent accidental double-sends in the main screen. */
  RAPID_SEND: 500,
} as const;

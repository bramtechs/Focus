/**
 * How a never-seen (uncached) domain is handled:
 * - "wait": hold the DNS reply up to WAIT_TIMEOUT_MS for Jev, then allow and use the verdict next time.
 * - "background": answer immediately; classify in the background and apply the verdict next time.
 * - "offline": never call Jev; only allow/block lists, the offline heuristic and cached verdicts.
 */
export type NewDomainMode = "wait" | "background" | "offline";
export const NEW_DOMAIN_MODES: readonly NewDomainMode[] = ["wait", "background", "offline"];

export interface BlockingState {
  /** Global override: block until switched off. */
  enabled: boolean;
  /** Epoch ms a timed focus session ends (blocking on until then), or null. */
  focusUntil: number | null;
  newDomainMode: NewDomainMode;
}

export const DEFAULT_STATE: BlockingState = {
  enabled: true,
  focusUntil: null,
  newDomainMode: "wait",
};

export type BlockingStatus =
  | { kind: "on"; active: true }
  | { kind: "off"; active: false }
  | { kind: "focus"; active: true; focusUntil: number; remainingMs: number };

export function blockingStatus(state: BlockingState, now: number): BlockingStatus {
  if (state.enabled) return { kind: "on", active: true };
  if (state.focusUntil != null && state.focusUntil > now) {
    return { kind: "focus", active: true, focusUntil: state.focusUntil, remainingMs: state.focusUntil - now };
  }
  return { kind: "off", active: false };
}

/** Turn blocking permanently on or off; either ends a running focus session. */
export function setEnabled(state: BlockingState, enabled: boolean): BlockingState {
  return { ...state, enabled, focusUntil: null };
}

/** Block for `minutes` from now, then turn blocking off. Replaces any running session. */
export function startFocus(state: BlockingState, minutes: number, now: number): BlockingState {
  return { ...state, enabled: false, focusUntil: now + minutes * 60_000 };
}

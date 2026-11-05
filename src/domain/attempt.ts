export type AttemptState =
  | "queued"
  | "broadcast"
  | "confirmed"
  | "failed"
  | "expired";

const MOVES: Record<AttemptState, readonly AttemptState[]> = {
  broadcast: ["broadcast", "confirmed", "failed", "expired"],
  confirmed: [],
  expired: [],
  failed: [],
  // queued -> confirmed: preflight can find the settlement already on chain.
  queued: ["broadcast", "confirmed", "failed", "expired"],
};

export const canMove = (from: AttemptState, to: AttemptState): boolean =>
  MOVES[from].includes(to);

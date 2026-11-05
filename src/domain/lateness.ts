const DAY_MS = 86_400_000;

export type Tier = "friendly" | "firm" | "final";

export const tierFor = (days: number): Tier => {
  if (days < 7) {
    return "friendly";
  }
  return days < 14 ? "firm" : "final";
};

export const daysLate = (dueAt: string, now: Date): number =>
  Math.max(0, Math.floor((now.getTime() - Date.parse(dueAt)) / DAY_MS));

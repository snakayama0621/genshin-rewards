import type { HistoryEntry } from "../shared/types";
import type { Deps } from "./deps";
import { DAY_MS } from "../shared/time";

export const HISTORY_LIMIT = 300;
export const HISTORY_RETENTION_MS = 30 * DAY_MS;

export type HistoryInput = Omit<HistoryEntry, "id" | "at" | "code"> &
  Partial<Pick<HistoryEntry, "code">>;

/** 30日より古いものを除き、新しい順に最大300件を残す（保存順は古い→新しい）。 */
export function pruneHistory(
  entries: readonly HistoryEntry[],
  now: number,
): HistoryEntry[] {
  return entries
    .filter((entry) => entry.at >= now - HISTORY_RETENTION_MS)
    .slice(-HISTORY_LIMIT);
}

export async function appendHistory(deps: Deps, input: HistoryInput): Promise<void> {
  const now = deps.now();
  const entry: HistoryEntry = {
    id: deps.randomId(),
    at: now,
    code: null,
    ...input,
  };
  await deps.store.update("history", (prev) => pruneHistory([...prev, entry], now));
}

import {
  CHECKIN_DISPLAY,
  checkinDisplayOf,
  describeCheckinResult,
  type CheckinDisplay,
  type StatusView,
} from "../shared/labels";
import type {
  AccountState,
  CheckinState,
  CodeRecord,
  GameDay,
  GameRole,
  HistoryEntry,
  HistoryOutcome,
  RedeemState,
  TaskName,
  Uid,
} from "../shared/types";

export const ACCOUNT_STALE_MS = 10 * 60_000;
export const POPUP_HISTORY_LIMIT = 5;

/** The role matching `selectedUid`, otherwise the highest-level role. */
export function selectRole(
  roles: readonly GameRole[],
  selectedUid: Uid | null,
): GameRole | null {
  const selected = roles.find((role) => role.uid === selectedUid);
  if (selected) return selected;
  let best: GameRole | null = null;
  for (const role of roles) {
    if (best === null || role.level > best.level) best = role;
  }
  return best;
}

export function shouldRefreshAccount(
  account: AccountState,
  now: number,
): boolean {
  return (
    account.roles.length === 0 ||
    account.fetchedAt === null ||
    now - account.fetchedAt >= ACCOUNT_STALE_MS
  );
}

export interface CheckinView {
  readonly display: CheckinDisplay;
  readonly status: StatusView;
  readonly detail: string;
}

export function checkinView(state: CheckinState, today: GameDay): CheckinView {
  const display = checkinDisplayOf(state, today);
  const todayResult = state.gameDay === today ? state.result : null;
  return {
    display,
    status: CHECKIN_DISPLAY[display],
    detail:
      todayResult === null
        ? "本日はまだ受け取っていません"
        : describeCheckinResult(todayResult),
  };
}

function isRedeemedFor(redeem: RedeemState, uid: Uid, code: string): boolean {
  const status = redeem.codes[`${uid}:${code}`]?.status;
  return status === "redeemed" || status === "already_redeemed";
}

export function redeemSummaryView(
  redeem: RedeemState,
  uid: Uid | null,
): StatusView {
  if (redeem.availableFetchedAt === null)
    return { label: "有効コード 未確認", tone: "neutral" };
  const total = redeem.available.length;
  const done =
    uid === null
      ? 0
      : redeem.available.filter((code) => isRedeemedFor(redeem, uid, code))
          .length;
  return {
    label: `有効コード ${String(total)} 件中 ${String(done)} 件 引き換え済み`,
    tone: total > 0 && done === total ? "success" : "neutral",
  };
}

/** Code records for one uid, most recently updated first. */
export function codeRecordsFor(
  redeem: RedeemState,
  uid: Uid | null,
): CodeRecord[] {
  if (uid === null) return [];
  return Object.values(redeem.codes)
    .filter((record) => record.uid === uid)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export interface HistoryFilter {
  readonly task: TaskName | "all";
  readonly outcome: HistoryOutcome | "all";
}

/** Matching history entries, newest first. */
export function filterHistory(
  history: readonly HistoryEntry[],
  filter: HistoryFilter,
): HistoryEntry[] {
  return history
    .filter(
      (entry) =>
        (filter.task === "all" || entry.task === filter.task) &&
        (filter.outcome === "all" || entry.outcome === filter.outcome),
    )
    .sort((a, b) => b.at - a.at);
}

export function recentHistory(
  history: readonly HistoryEntry[],
  limit = POPUP_HISTORY_LIMIT,
): HistoryEntry[] {
  return filterHistory(history, { task: "all", outcome: "all" }).slice(
    0,
    limit,
  );
}

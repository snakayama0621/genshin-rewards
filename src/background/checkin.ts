import { describeCheckinResult } from "../shared/labels";
import { checkinDueAt, gameDayOf } from "../shared/time";
import type {
  CheckinResult,
  CheckinState,
  GameDay,
  HistoryOutcome,
  Settings,
  Trigger,
} from "../shared/types";
import { fetchCheckinInfo, signIn } from "./api/hoyo";
import type { Deps } from "./deps";
import { appendHistory } from "./history";
import { notify, type NoticeRequest } from "./notify";
import { observeSession } from "./session";
import { singleFlight } from "./single-flight";

export const MAX_AUTO_ATTEMPTS = 3;
export const CHECKIN_RETRY_DELAY_MS = 30 * 60_000;

type Claimed = Extract<CheckinResult, { kind: "claimed" | "already_claimed" }>;

export function isClaimed(result: CheckinResult | null): result is Claimed {
  return result?.kind === "claimed" || result?.kind === "already_claimed";
}

function isRetryable(result: CheckinResult): boolean {
  return (
    result.kind === "error" ||
    result.kind === "rate_limited" ||
    result.kind === "not_logged_in"
  );
}

/**
 * 自動実行の失敗後、30分後の再試行が必要ならその時刻（DESIGN §4.1 手順5）。
 * 実行時刻が後ろへ変更された場合は、その予定より前には鳴らさない。
 */
export function checkinRetryAt(
  settings: Settings,
  state: CheckinState,
  today: GameDay,
): number | null {
  if (!settings.autoCheckin || state.gameDay !== today) return null;
  if (state.result === null || state.lastRunAt === null) return null;
  if (!isRetryable(state.result)) return null;
  if (state.autoAttempts < 1 || state.autoAttempts >= MAX_AUTO_ATTEMPTS)
    return null;
  return Math.max(
    state.lastRunAt + CHECKIN_RETRY_DELAY_MS,
    checkinDueAt(today, settings.checkinTime),
  );
}

async function claim(deps: Deps): Promise<CheckinResult> {
  const info = await fetchCheckinInfo(deps);
  await observeSession(deps, "hoyolab", info.kind);
  if (info.kind !== "ok") return info;
  if (info.isSign)
    return { kind: "already_claimed", totalSignDay: info.totalSignDay };
  const signed = await signIn(deps);
  await observeSession(deps, "hoyolab", signed.kind);
  switch (signed.kind) {
    case "claimed":
    case "already_claimed":
      // info の時点で未受取だったので、受取後の日数は info の値 + 1
      return { kind: signed.kind, totalSignDay: info.totalSignDay + 1 };
    default:
      return signed;
  }
}

function outcomeOf(result: CheckinResult): HistoryOutcome {
  if (result.kind === "claimed") return "success";
  return result.kind === "already_claimed" ? "skipped" : "failure";
}

function noticeFor(result: CheckinResult): NoticeRequest | null {
  const message = describeCheckinResult(result);
  switch (result.kind) {
    case "claimed":
      return {
        setting: "checkinSuccess",
        target: "none",
        title: "ログインボーナス",
        message,
      };
    case "captcha":
      return {
        setting: "failure",
        target: "checkin-page",
        title: "ログインボーナスの受取に失敗",
        message,
      };
    case "error":
    case "rate_limited":
      return {
        setting: "failure",
        target: "options",
        title: "ログインボーナスの受取に失敗",
        message,
      };
    case "already_claimed":
    case "not_logged_in": // ログイン切れは session の通知に任せる
      return null;
    default: {
      const exhaustive: never = result;
      return exhaustive;
    }
  }
}

async function run(deps: Deps, trigger: Trigger): Promise<CheckinResult> {
  const today = gameDayOf(deps.now());
  const current = await deps.store.get("checkin");
  if (current.gameDay === today && isClaimed(current.result))
    return current.result;

  const result = await claim(deps);
  const saved = await deps.store.update("checkin", (prev) => ({
    gameDay: today,
    result,
    autoAttempts:
      (prev.gameDay === today ? prev.autoAttempts : 0) +
      (trigger === "manual" ? 0 : 1),
    lastRunAt: deps.now(),
  }));
  const message = describeCheckinResult(result);
  await appendHistory(deps, {
    task: "checkin",
    trigger,
    outcome: outcomeOf(result),
    message,
  });

  // 自動の再試行が控えている失敗は、最後の試行まで通知しない
  const settings = await deps.store.get("settings");
  const retryPending =
    trigger !== "manual" && checkinRetryAt(settings, saved, today) !== null;
  const notice = noticeFor(result);
  if (notice && !(retryPending && notice.setting === "failure"))
    await notify(deps, notice);
  return result;
}

/** ログボ受取（DESIGN §4.1）。当日受取済みなら通信しない。 */
export const runCheckin = singleFlight(run);

import { checkinDueAt, gameDayOf, HOUR_MS, nextGameDay } from "../shared/time";
import type {
  CheckinState,
  RedeemMode,
  RedeemRunResult,
  RedeemState,
  Settings,
  Trigger,
} from "../shared/types";
import {
  checkinRetryAt,
  isClaimed,
  MAX_AUTO_ATTEMPTS,
  runCheckin,
} from "./checkin";
import {
  ALARM_NAMES,
  isAlarmName,
  type AlarmInfo,
  type AlarmName,
  type AlarmSpec,
  type Deps,
} from "./deps";
import { runCodeCheck, runRedeemAll } from "./redeem";

/** 自動ログボを今実行すべきか（DESIGN §4.5）。 */
export function isCheckinDue(
  settings: Settings,
  state: CheckinState,
  now: number,
): boolean {
  if (!settings.autoCheckin) return false;
  const today = gameDayOf(now);
  if (now < checkinDueAt(today, settings.checkinTime)) return false;
  if (state.gameDay !== today) return true;
  if (isClaimed(state.result) || state.result?.kind === "captcha") return false;
  return state.autoAttempts < MAX_AUTO_ATTEMPTS;
}

/** 交換で CAPTCHA が出た日は、自動の交換を止める（手動は可能）。 */
function isRedeemHalted(state: RedeemState, now: number): boolean {
  return state.captchaDay === gameDayOf(now);
}

interface RedeemJob {
  readonly run: (deps: Deps, trigger: Trigger) => Promise<RedeemRunResult>;
  /** 確認間隔を数え始める時刻。null ならすぐ実行してよい */
  readonly since: number | null;
}

/** 定期確認のモードから、実行する処理を決める。モードで分岐するのはここだけ。 */
function redeemJob(
  mode: RedeemMode,
  state: RedeemState,
  now: number,
): RedeemJob | null {
  switch (mode) {
    case "off":
      return null;
    case "notify":
      return { run: runCodeCheck, since: state.lastRunAt };
    case "auto":
      if (isRedeemHalted(state, now)) return null;
      // 通知モードの確認は引き換えていないため、前回の実行に数えない
      return {
        run: runRedeemAll,
        since: state.lastResult?.kind === "checked" ? null : state.lastRunAt,
      };
    default: {
      const exhaustive: never = mode;
      return exhaustive;
    }
  }
}

/** 前回実行から設定間隔以上たっていれば、実行すべき処理を返す。 */
function dueRedeemJob(
  settings: Settings,
  state: RedeemState,
  now: number,
): RedeemJob | null {
  const job = redeemJob(settings.redeemMode, state, now);
  if (job === null || job.since === null) return job;
  return now - job.since >= settings.redeemIntervalHours * HOUR_MS ? job : null;
}

/** 当日が未完了で予定が未来ならその時刻、それ以外は翌日の予定。 */
function nextCheckinAt(
  settings: Settings,
  state: CheckinState,
  now: number,
): number {
  const today = gameDayOf(now);
  const dueToday = checkinDueAt(today, settings.checkinTime);
  const doneToday = state.gameDay === today && isClaimed(state.result);
  return !doneToday && dueToday > now
    ? dueToday
    : checkinDueAt(nextGameDay(today), settings.checkinTime);
}

export function desiredAlarms(
  settings: Settings,
  checkin: CheckinState,
  now: number,
): Readonly<Record<AlarmName, AlarmSpec | null>> {
  const retryAt = checkinRetryAt(settings, checkin, gameDayOf(now));
  const periodInMinutes = settings.redeemIntervalHours * 60;
  return {
    checkin: settings.autoCheckin
      ? { when: nextCheckinAt(settings, checkin, now) }
      : null,
    "checkin-retry": retryAt === null ? null : { when: retryAt },
    redeem: settings.redeemMode !== "off"
      ? { when: now + periodInMinutes * 60_000, periodInMinutes }
      : null,
  };
}

function matches(existing: AlarmInfo, spec: AlarmSpec): boolean {
  // 繰り返しアラームは間隔が同じなら作り直さない（作り直すと次回時刻が延びる）
  return spec.periodInMinutes === undefined
    ? existing.scheduledTime === spec.when
    : existing.periodInMinutes === spec.periodInMinutes;
}

/** 設定と状態から正しいアラームを計算し、差分だけ登録・削除する。 */
export async function ensureAlarms(deps: Deps): Promise<void> {
  const settings = await deps.store.get("settings");
  const checkin = await deps.store.get("checkin");
  const desired = desiredAlarms(settings, checkin, deps.now());
  for (const name of ALARM_NAMES) {
    const spec = desired[name];
    const existing = await deps.alarms.get(name);
    if (spec === null) {
      if (existing) await deps.alarms.clear(name);
    } else if (!existing || !matches(existing, spec)) {
      await deps.alarms.create(name, spec);
    }
  }
}

export async function handleAlarm(deps: Deps, name: string): Promise<void> {
  if (!isAlarmName(name)) return;
  const settings = await deps.store.get("settings");
  switch (name) {
    case "checkin":
    case "checkin-retry": {
      const checkin = await deps.store.get("checkin");
      if (isCheckinDue(settings, checkin, deps.now())) {
        await runCheckin(deps, name === "checkin" ? "auto" : "retry");
      }
      break;
    }
    case "redeem": {
      // 前回実行の所要時間ぶん間隔が短く見えるため、ここでは間隔を確かめない
      const job = redeemJob(
        settings.redeemMode,
        await deps.store.get("redeem"),
        deps.now(),
      );
      if (job) await job.run(deps, "auto");
      break;
    }
    default: {
      const exhaustive: never = name;
      return exhaustive;
    }
  }
  await ensureAlarms(deps);
}

/** 起動・インストール・設定変更時の取りこぼし対策。実行すべき処理を即時に実行してからアラームを整える。 */
export async function reconcile(
  deps: Deps,
  trigger: Extract<Trigger, "startup" | "auto">,
): Promise<void> {
  const settings = await deps.store.get("settings");
  const checkin = await deps.store.get("checkin");
  const now = deps.now();
  const retryAt = checkinRetryAt(settings, checkin, gameDayOf(now));
  // 30分後の再試行が控えているなら、それより早くは試さない
  if (
    isCheckinDue(settings, checkin, now) &&
    (retryAt === null || retryAt <= now)
  ) {
    await runCheckin(deps, trigger);
  }
  const job = dueRedeemJob(settings, await deps.store.get("redeem"), deps.now());
  if (job) await job.run(deps, trigger);
  await ensureAlarms(deps);
}

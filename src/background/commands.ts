import {
  describeCheckinResult,
  describeRedeemOutcome,
  describeRedeemRun,
} from "../shared/labels";
import {
  commandSchema,
  settingsPatchSchema,
  type SettingsPatch,
} from "../shared/schema";
import type { Command, CommandResponse, Settings } from "../shared/types";
import { refreshAccount, type AccountResult } from "./account";
import { isClaimed, runCheckin } from "./checkin";
import type { Deps } from "./deps";
import { appendHistory } from "./history";
import { logError } from "./log";
import { isTerminal, redeemManually, runRedeemAll } from "./redeem";
import { ensureAlarms, reconcile } from "./scheduler";

const ok = (message: string): CommandResponse => ({ ok: true, message });
const fail = (error: string): CommandResponse => ({ ok: false, error });

/** UI から届いた未検証のメッセージを検証し、各処理へ振り分ける。 */
export async function handleCommand(
  deps: Deps,
  raw: unknown,
): Promise<CommandResponse> {
  const parsed = commandSchema.safeParse(raw);
  if (!parsed.success) return fail("不正なコマンドです");
  try {
    return await dispatch(deps, parsed.data);
  } catch (error) {
    logError(`command ${parsed.data.type} failed`, error);
    return fail("処理中にエラーが発生しました");
  }
}

async function dispatch(
  deps: Deps,
  command: Command,
): Promise<CommandResponse> {
  switch (command.type) {
    case "checkin": {
      const result = await runCheckin(deps, "manual");
      await ensureAlarms(deps);
      const message = describeCheckinResult(result);
      return isClaimed(result) ? ok(message) : fail(message);
    }
    case "redeemAll": {
      const result = await runRedeemAll(deps, "manual");
      const message = describeRedeemRun(result);
      return result.kind === "done" ? ok(message) : fail(message);
    }
    case "redeemCode": {
      const result = await redeemManually(deps, command.code);
      if (result.kind === "invalid_format")
        return fail("交換コードは半角英数字30文字以内です");
      const message = describeRedeemOutcome(result);
      return isTerminal(result)
        ? ok(message)
        : fail(message);
    }
    case "refreshAccount":
      return refreshAccountCommand(deps);
    case "updateSettings":
      return updateSettings(deps, command.patch);
    case "clearHistory":
      await deps.store.update("history", () => []);
      return ok("履歴を消去しました");
    default: {
      const exhaustive: never = command;
      return exhaustive;
    }
  }
}

function describeAccount(result: AccountResult): string {
  switch (result.kind) {
    case "ok":
      return result.fetched
        ? `キャラクターを ${String(result.roles.length)} 件取得しました`
        : "直前に取得済みのため、保存済みの一覧を表示しています";
    case "not_logged_in":
      return "キャラクター情報を取得できません。HoYoLABまたは公式交換サイトにログインしてください";
    case "captcha":
      return "セキュリティ認証（CAPTCHA）が必要です";
    case "rate_limited":
      return "アクセスが集中しているため中断しました";
    case "error":
      return `エラー: ${result.message}`;
    default: {
      const exhaustive: never = result;
      return exhaustive;
    }
  }
}

async function refreshAccountCommand(deps: Deps): Promise<CommandResponse> {
  const result = await refreshAccount(deps);
  const message = describeAccount(result);
  if (result.kind === "ok" && !result.fetched) return ok(message);
  await appendHistory(deps, {
    task: "account",
    trigger: "manual",
    outcome: result.kind === "ok" ? "success" : "failure",
    message,
  });
  return result.kind === "ok" ? ok(message) : fail(message);
}

function pick<T>(value: T | undefined, fallback: T): T {
  return value === undefined ? fallback : value;
}

/** 指定された項目だけを上書きする。通知設定は項目ごとに部分更新する。 */
export function mergeSettings(prev: Settings, patch: SettingsPatch): Settings {
  const n = patch.notifications ?? {};
  return {
    autoCheckin: pick(patch.autoCheckin, prev.autoCheckin),
    checkinTime: pick(patch.checkinTime, prev.checkinTime),
    redeemMode: pick(patch.redeemMode, prev.redeemMode),
    redeemIntervalHours: pick(
      patch.redeemIntervalHours,
      prev.redeemIntervalHours,
    ),
    selectedUid: pick(patch.selectedUid, prev.selectedUid),
    notifications: {
      checkinSuccess: pick(n.checkinSuccess, prev.notifications.checkinSuccess),
      redeemSuccess: pick(n.redeemSuccess, prev.notifications.redeemSuccess),
      failure: pick(n.failure, prev.notifications.failure),
      sessionExpired: pick(n.sessionExpired, prev.notifications.sessionExpired),
    },
  };
}

async function updateSettings(
  deps: Deps,
  rawPatch: unknown,
): Promise<CommandResponse> {
  const patch = settingsPatchSchema.safeParse(rawPatch);
  if (!patch.success) {
    const path = patch.error.issues[0]?.path.join(".") ?? "";
    return fail(`設定の値が正しくありません（${path}）`);
  }
  await deps.store.update("settings", (prev) =>
    mergeSettings(prev, patch.data),
  );
  await ensureAlarms(deps);
  // 有効化で必要になった取りこぼし実行は時間がかかるため、応答を待たせない
  reconcile(deps, "auto").catch((error: unknown) => {
    logError("reconcile after settings change failed", error);
  });
  return ok("設定を保存しました");
}

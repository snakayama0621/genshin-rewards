import type {
  CheckinResult,
  CheckinState,
  CodeStatus,
  GameDay,
  HistoryOutcome,
  RedeemMode,
  RedeemOutcome,
  RedeemRunResult,
  SessionStatus,
  TaskName,
  Trigger,
} from "./types";

export type Tone = "success" | "warning" | "danger" | "neutral";

export interface StatusView {
  readonly label: string;
  readonly tone: Tone;
}

export type CheckinDisplay =
  "claimed" | "pending" | "captcha" | "not_logged_in" | "failed";

export const CHECKIN_DISPLAY: Readonly<Record<CheckinDisplay, StatusView>> = {
  claimed: { label: "受取済み", tone: "success" },
  pending: { label: "未受取", tone: "neutral" },
  captcha: { label: "要認証", tone: "warning" },
  not_logged_in: { label: "要ログイン", tone: "warning" },
  failed: { label: "失敗", tone: "danger" },
};

export function checkinDisplayOf(
  state: CheckinState,
  today: GameDay,
): CheckinDisplay {
  if (state.gameDay !== today || state.result === null) return "pending";
  switch (state.result.kind) {
    case "claimed":
    case "already_claimed":
      return "claimed";
    case "captcha":
      return "captcha";
    case "not_logged_in":
      return "not_logged_in";
    case "rate_limited":
    case "error":
      return "failed";
    default: {
      const exhaustive: never = state.result;
      return exhaustive;
    }
  }
}

export const CODE_STATUS_VIEW: Readonly<Record<CodeStatus, StatusView>> = {
  redeemed: { label: "引き換え済み", tone: "success" },
  already_redeemed: { label: "使用済み", tone: "success" },
  expired: { label: "期限切れ", tone: "neutral" },
  invalid: { label: "無効", tone: "neutral" },
  usage_limit: { label: "上限到達", tone: "neutral" },
  region_locked: { label: "対象外の地域", tone: "neutral" },
  level_too_low: { label: "冒険ランク不足", tone: "warning" },
  failed: { label: "失敗", tone: "danger" },
};

export const SESSION_VIEW: Readonly<Record<SessionStatus, StatusView>> = {
  unknown: { label: "未確認", tone: "neutral" },
  active: { label: "ログイン中", tone: "success" },
  expired: { label: "未ログイン", tone: "warning" },
};

export const OUTCOME_VIEW: Readonly<Record<HistoryOutcome, StatusView>> = {
  success: { label: "成功", tone: "success" },
  skipped: { label: "スキップ", tone: "neutral" },
  failure: { label: "失敗", tone: "danger" },
};

export const TASK_LABEL: Readonly<Record<TaskName, string>> = {
  checkin: "ログインボーナス",
  redeem: "交換コード",
  account: "アカウント",
};

export const TRIGGER_LABEL: Readonly<Record<Trigger, string>> = {
  auto: "自動",
  manual: "手動",
  startup: "起動時",
  retry: "再試行",
};

export const REDEEM_MODE_LABEL: Readonly<Record<RedeemMode, string>> = {
  off: "オフ",
  notify: "新しいコードを通知",
  auto: "自動で引き換え",
};

const FAILURE_MESSAGE = {
  not_logged_in: "ログインが必要です",
  captcha:
    "セキュリティ認証（CAPTCHA）が必要です。公式ページで手動で受け取ってください",
  rate_limited: "アクセスが集中しているため中断しました",
} as const;

export function describeCheckinResult(result: CheckinResult): string {
  switch (result.kind) {
    case "claimed":
      return `ログインボーナスを受け取りました（今月 ${String(result.totalSignDay)} 日目）`;
    case "already_claimed":
      return `本日は受取済みです（今月 ${String(result.totalSignDay)} 日）`;
    case "not_logged_in":
      return `HoYoLABの${FAILURE_MESSAGE.not_logged_in}`;
    case "captcha":
    case "rate_limited":
      return FAILURE_MESSAGE[result.kind];
    case "error":
      return `エラー: ${result.message}`;
    default: {
      const exhaustive: never = result;
      return exhaustive;
    }
  }
}

export function describeRedeemOutcome(outcome: RedeemOutcome): string {
  switch (outcome.kind) {
    case "cooldown":
      return "連続で引き換えたため一時的に制限されています。次回の実行で再試行します";
    case "no_role":
      return "原神のキャラクターが見つかりません";
    case "not_logged_in":
      return `公式交換サイト（HoYoverse）への${FAILURE_MESSAGE.not_logged_in}`;
    case "captcha":
    case "rate_limited":
      return FAILURE_MESSAGE[outcome.kind];
    case "error":
      return `エラー: ${outcome.message}`;
    default:
      return CODE_STATUS_VIEW[outcome.kind].label;
  }
}

export function describeRedeemRun(result: RedeemRunResult): string {
  switch (result.kind) {
    case "done":
      return `新規 ${String(result.redeemed)} 件、対象外 ${String(result.skipped)} 件、失敗 ${String(result.failed)} 件`;
    case "checked":
      return result.fresh > 0
        ? `新しいコードが ${String(result.fresh)} 件見つかりました`
        : "新しいコードはありません";
    case "source_error":
      return `交換コードの取得に失敗しました: ${result.message}`;
    default:
      return describeRedeemOutcome(result);
  }
}

export const SERVERS = ["os_usa", "os_euro", "os_asia", "os_cht"] as const;
export type Server = (typeof SERVERS)[number];

export type Uid = string & { readonly __brand: "Uid" };
export type RedeemCode = string & { readonly __brand: "RedeemCode" };
export type GameDay = string & { readonly __brand: "GameDay" };
export type TimeOfDay = string & { readonly __brand: "TimeOfDay" };

export interface GameRole {
  readonly uid: Uid;
  readonly nickname: string;
  readonly level: number;
  readonly server: Server;
  readonly serverName: string;
}

export type Trigger = "auto" | "manual" | "startup" | "retry";
export type TaskName = "checkin" | "redeem" | "account";

export type SessionStatus = "unknown" | "active" | "expired";

export interface SessionState {
  readonly hoyolab: SessionStatus;
  readonly hoyoverse: SessionStatus;
}

export type FailureResult =
  | { readonly kind: "not_logged_in" }
  | { readonly kind: "captcha" }
  | { readonly kind: "rate_limited" }
  | { readonly kind: "error"; readonly message: string };

export type CheckinResult =
  | { readonly kind: "claimed"; readonly totalSignDay: number }
  | { readonly kind: "already_claimed"; readonly totalSignDay: number }
  | FailureResult;

export interface CheckinState {
  readonly gameDay: GameDay | null;
  readonly result: CheckinResult | null;
  readonly autoAttempts: number;
  readonly lastRunAt: number | null;
}

export const TERMINAL_CODE_STATUSES = [
  "redeemed",
  "already_redeemed",
  "expired",
  "invalid",
  "usage_limit",
  "region_locked",
  "level_too_low",
] as const;
export type TerminalCodeStatus = (typeof TERMINAL_CODE_STATUSES)[number];
export type CodeStatus = TerminalCodeStatus | "failed";

export type RedeemOutcome =
  | { readonly kind: TerminalCodeStatus }
  | { readonly kind: "cooldown" }
  | { readonly kind: "no_role" }
  | FailureResult;

export interface CodeRecord {
  readonly code: RedeemCode;
  readonly uid: Uid;
  readonly status: CodeStatus;
  readonly attempts: number;
  readonly updatedAt: number;
  readonly message: string;
}

export type RedeemRunResult =
  | {
      readonly kind: "done";
      readonly redeemed: number;
      readonly skipped: number;
      readonly failed: number;
    }
  | { readonly kind: "checked"; readonly fresh: number }
  | { readonly kind: "no_role" }
  | { readonly kind: "source_error"; readonly message: string }
  | { readonly kind: "cooldown" }
  | FailureResult;

export interface RedeemState {
  readonly codes: Readonly<Record<string, CodeRecord>>;
  readonly available: readonly RedeemCode[];
  readonly availableFetchedAt: number | null;
  readonly lastRunAt: number | null;
  readonly lastResult: RedeemRunResult | null;
  /** 交換APIが最後に CAPTCHA を返したゲーム内日付。この日は自動の交換を止める */
  readonly captchaDay: GameDay | null;
}

export interface AccountState {
  readonly roles: readonly GameRole[];
  readonly fetchedAt: number | null;
}

export type HistoryOutcome = "success" | "skipped" | "failure";

export interface HistoryEntry {
  readonly id: string;
  readonly at: number;
  readonly task: TaskName;
  readonly trigger: Trigger;
  readonly outcome: HistoryOutcome;
  readonly message: string;
  readonly code: RedeemCode | null;
}

export const REDEEM_INTERVAL_HOURS = [1, 3, 6, 12, 24] as const;
export type RedeemIntervalHours = (typeof REDEEM_INTERVAL_HOURS)[number];

/** off: 何もしない、notify: 公開のコード一覧だけを見て通知、auto: 引き換える。 */
export const REDEEM_MODES = ["off", "notify", "auto"] as const;
export type RedeemMode = (typeof REDEEM_MODES)[number];

export interface NotificationSettings {
  readonly checkinSuccess: boolean;
  readonly redeemSuccess: boolean;
  readonly failure: boolean;
  readonly sessionExpired: boolean;
}

export interface Settings {
  readonly autoCheckin: boolean;
  readonly checkinTime: TimeOfDay;
  readonly redeemMode: RedeemMode;
  readonly redeemIntervalHours: RedeemIntervalHours;
  readonly notifications: NotificationSettings;
  readonly selectedUid: Uid | null;
}

export interface StorageSchema {
  readonly settings: Settings;
  readonly session: SessionState;
  readonly account: AccountState;
  readonly checkin: CheckinState;
  readonly redeem: RedeemState;
  readonly history: readonly HistoryEntry[];
}
export type StorageKey = keyof StorageSchema;

export type Command =
  | { readonly type: "checkin" }
  | { readonly type: "redeemAll" }
  | { readonly type: "redeemCode"; readonly code: string }
  | { readonly type: "refreshAccount" }
  | { readonly type: "updateSettings"; readonly patch: unknown }
  | { readonly type: "clearHistory" };

export type CommandResponse =
  | { readonly ok: true; readonly message: string }
  | { readonly ok: false; readonly error: string };

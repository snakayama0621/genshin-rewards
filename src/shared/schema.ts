import { z } from "zod";
import {
  REDEEM_INTERVAL_HOURS,
  REDEEM_MODES,
  SERVERS,
  TERMINAL_CODE_STATUSES,
  type AccountState,
  type CheckinState,
  type CodeRecord,
  type Command,
  type GameDay,
  type GameRole,
  type HistoryEntry,
  type RedeemCode,
  type RedeemRunResult,
  type RedeemState,
  type SessionState,
  type Settings,
  type StorageSchema,
  type TimeOfDay,
  type Uid,
} from "./types";

// 拡張機能の CSP は eval を禁止しているため、Zod の new Function による高速化を使わない
z.config({ jitless: true });

const UID_PATTERN = /^\d{9,10}$/;
const REDEEM_CODE_PATTERN = /^[0-9A-Za-z]{1,30}$/;
const GAME_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_OF_DAY_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isUid(value: unknown): value is Uid {
  return typeof value === "string" && UID_PATTERN.test(value);
}

export function isRedeemCode(value: unknown): value is RedeemCode {
  return typeof value === "string" && REDEEM_CODE_PATTERN.test(value);
}

export function isGameDay(value: unknown): value is GameDay {
  return typeof value === "string" && GAME_DAY_PATTERN.test(value);
}

export function isTimeOfDay(value: unknown): value is TimeOfDay {
  return typeof value === "string" && TIME_OF_DAY_PATTERN.test(value);
}

export const uidSchema = z.custom<Uid>(isUid, "UIDの形式が正しくありません");
export const redeemCodeSchema = z.custom<RedeemCode>(
  isRedeemCode,
  "交換コードは半角英数字30文字以内です",
);
export const gameDaySchema = z.custom<GameDay>(isGameDay);
export const timeOfDaySchema = z.custom<TimeOfDay>(
  isTimeOfDay,
  "時刻は HH:MM 形式で指定してください",
);
export const serverSchema = z.enum(SERVERS);
export const redeemIntervalSchema = z.union(
  REDEEM_INTERVAL_HOURS.map((hours) => z.literal(hours)),
);

const failureSchemas = [
  z.object({ kind: z.literal("not_logged_in") }),
  z.object({ kind: z.literal("captcha") }),
  z.object({ kind: z.literal("rate_limited") }),
  z.object({ kind: z.literal("error"), message: z.string() }),
] as const;

const checkinResultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("claimed"),
    totalSignDay: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal("already_claimed"),
    totalSignDay: z.number().int().nonnegative(),
  }),
  ...failureSchemas,
]);

const redeemRunResultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("done"),
    redeemed: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal("checked"),
    fresh: z.number().int().nonnegative(),
  }),
  z.object({ kind: z.literal("no_role") }),
  z.object({ kind: z.literal("source_error"), message: z.string() }),
  z.object({ kind: z.literal("cooldown") }),
  ...failureSchemas,
]) satisfies z.ZodType<RedeemRunResult>;

export const gameRoleSchema = z.object({
  uid: uidSchema,
  nickname: z.string(),
  level: z.number().int().nonnegative(),
  server: serverSchema,
  serverName: z.string(),
}) satisfies z.ZodType<GameRole>;

const codeRecordSchema = z.object({
  code: redeemCodeSchema,
  uid: uidSchema,
  status: z.enum([...TERMINAL_CODE_STATUSES, "failed"]),
  attempts: z.number().int().nonnegative(),
  updatedAt: z.number(),
  message: z.string(),
}) satisfies z.ZodType<CodeRecord>;

const historyEntrySchema = z.object({
  id: z.string(),
  at: z.number(),
  task: z.enum(["checkin", "redeem", "account"]),
  trigger: z.enum(["auto", "manual", "startup", "retry"]),
  outcome: z.enum(["success", "skipped", "failure"]),
  message: z.string(),
  code: redeemCodeSchema.nullable(),
}) satisfies z.ZodType<HistoryEntry>;

const sessionStatusSchema = z.enum(["unknown", "active", "expired"]);

function mustBe<T>(guard: (value: unknown) => value is T, value: unknown): T {
  if (!guard(value)) throw new Error(`invalid constant: ${String(value)}`);
  return value;
}

export const DEFAULT_SETTINGS: Settings = {
  autoCheckin: false,
  checkinTime: mustBe(isTimeOfDay, "01:05"),
  redeemMode: "off",
  redeemIntervalHours: 3,
  notifications: {
    checkinSuccess: true,
    redeemSuccess: true,
    failure: true,
    sessionExpired: true,
  },
  selectedUid: null,
};

const notificationSettingsSchema = z.object({
  checkinSuccess: z
    .boolean()
    .catch(DEFAULT_SETTINGS.notifications.checkinSuccess),
  redeemSuccess: z
    .boolean()
    .catch(DEFAULT_SETTINGS.notifications.redeemSuccess),
  failure: z.boolean().catch(DEFAULT_SETTINGS.notifications.failure),
  sessionExpired: z
    .boolean()
    .catch(DEFAULT_SETTINGS.notifications.sessionExpired),
});

export const settingsSchema = z.object({
  autoCheckin: z.boolean().catch(DEFAULT_SETTINGS.autoCheckin),
  checkinTime: timeOfDaySchema.catch(DEFAULT_SETTINGS.checkinTime),
  redeemMode: z.enum(REDEEM_MODES).catch(DEFAULT_SETTINGS.redeemMode),
  redeemIntervalHours: redeemIntervalSchema.catch(
    DEFAULT_SETTINGS.redeemIntervalHours,
  ),
  notifications: notificationSettingsSchema.catch(
    DEFAULT_SETTINGS.notifications,
  ),
  selectedUid: uidSchema.nullable().catch(DEFAULT_SETTINGS.selectedUid),
}) satisfies z.ZodType<Settings>;

export const settingsPatchSchema = z
  .object({
    autoCheckin: z.boolean(),
    checkinTime: timeOfDaySchema,
    redeemMode: z.enum(REDEEM_MODES),
    redeemIntervalHours: redeemIntervalSchema,
    notifications: z
      .object({
        checkinSuccess: z.boolean(),
        redeemSuccess: z.boolean(),
        failure: z.boolean(),
        sessionExpired: z.boolean(),
      })
      .partial(),
    selectedUid: uidSchema.nullable(),
  })
  .partial()
  .strict();
export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

export const DEFAULT_STATE: StorageSchema = {
  settings: DEFAULT_SETTINGS,
  session: { hoyolab: "unknown", hoyoverse: "unknown" },
  account: { roles: [], fetchedAt: null },
  checkin: { gameDay: null, result: null, autoAttempts: 0, lastRunAt: null },
  redeem: {
    codes: {},
    available: [],
    availableFetchedAt: null,
    lastRunAt: null,
    lastResult: null,
    captchaDay: null,
  },
  history: [],
};

type StorageSchemas = { readonly [K in keyof StorageSchema]: z.ZodType<StorageSchema[K]> };

export const storageSchemas: StorageSchemas = {
  settings: settingsSchema,
  session: z.object({
    hoyolab: sessionStatusSchema,
    hoyoverse: sessionStatusSchema,
  }) satisfies z.ZodType<SessionState>,
  account: z.object({
    roles: z.array(gameRoleSchema),
    fetchedAt: z.number().nullable(),
  }) satisfies z.ZodType<AccountState>,
  checkin: z.object({
    gameDay: gameDaySchema.nullable(),
    result: checkinResultSchema.nullable(),
    autoAttempts: z.number().int().nonnegative(),
    lastRunAt: z.number().nullable(),
  }) satisfies z.ZodType<CheckinState>,
  redeem: z.object({
    codes: z.record(z.string(), codeRecordSchema),
    available: z.array(redeemCodeSchema),
    availableFetchedAt: z.number().nullable(),
    lastRunAt: z.number().nullable(),
    lastResult: redeemRunResultSchema.nullable(),
    // この項目がない旧形式の保存値で、コードの記録まで既定値に戻さないため
    captchaDay: gameDaySchema.nullable().catch(null),
  }) satisfies z.ZodType<RedeemState>,
  history: z.array(historyEntrySchema),
};

export function parseStored<K extends keyof StorageSchema>(
  key: K,
  raw: unknown,
): StorageSchema[K] {
  if (raw === undefined) return DEFAULT_STATE[key];
  const parsed = storageSchemas[key].safeParse(raw);
  if (parsed.success) return parsed.data;
  console.warn(`stored "${key}" is invalid; using defaults`);
  return DEFAULT_STATE[key];
}

export const commandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("checkin") }),
  z.object({ type: z.literal("redeemAll") }),
  z.object({ type: z.literal("redeemCode"), code: z.string().max(64) }),
  z.object({ type: z.literal("refreshAccount") }),
  z.object({ type: z.literal("updateSettings"), patch: z.unknown() }),
  z.object({ type: z.literal("clearHistory") }),
]) satisfies z.ZodType<Command>;

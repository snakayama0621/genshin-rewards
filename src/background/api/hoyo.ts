import { z } from "zod";
import { serverSchema, uidSchema } from "../../shared/schema";
import type {
  FailureResult,
  GameRole,
  RedeemCode,
  RedeemOutcome,
} from "../../shared/types";
import type { Deps } from "../deps";
import { request, type HttpRequest, type HttpResult } from "./http";

/** HoYoLAB / HoYoverse の仕様変更はこの表だけを直す（DESIGN §1）。 */
export const HOYO = {
  checkin: {
    base: "https://sg-act-public-api.hoyolab.com/event/sol",
    actId: "e202102251931481",
    lang: "ja-jp",
    headers: { "x-rpc-signgame": "hk4e" },
  },
  roles: {
    hoyolab:
      "https://api-account-os.hoyolab.com/account/binding/api/getUserGameRolesByCookieToken",
    hoyoverse:
      "https://api-account-os.hoyoverse.com/account/binding/api/getUserGameRolesByCookieToken",
    lang: "ja",
  },
  redeem: {
    url: "https://public-operation-hk4e.hoyoverse.com/common/apicdkey/api/webExchangeCdkey",
    lang: "ja",
    /** 連続で引き換えると -2016（クールダウン）になるため、手動・自動を問わず6秒あける */
    minIntervalMs: 6_000,
  },
  gameBiz: "hk4e_global",
} as const;

export type Domain = "hoyolab" | "hoyoverse";

type KindExceptError<T extends { kind: string }> = Exclude<T["kind"], "error">;

const COMMON_RETCODES: Readonly<Record<number, KindExceptError<FailureResult>>> = {
  [-100]: "not_logged_in",
  [-110]: "rate_limited",
  1028: "rate_limited",
  10101: "rate_limited",
  10035: "captcha",
  5003: "captcha",
  10041: "captcha",
  1034: "captcha",
};

const REDEEM_RETCODES: Readonly<Record<number, KindExceptError<RedeemOutcome>>> = {
  0: "redeemed",
  [-2001]: "expired",
  [-2003]: "invalid",
  [-2004]: "invalid",
  [-2014]: "invalid",
  [-1065]: "invalid",
  [-2006]: "usage_limit",
  [-2008]: "region_locked",
  [-2011]: "level_too_low",
  [-2021]: "level_too_low",
  [-2016]: "cooldown",
  [-2017]: "already_redeemed",
  [-2018]: "already_redeemed",
  [-1073]: "no_role",
  [-1071]: "not_logged_in",
};

const RETCODE_ALREADY_CLAIMED = -5003;

const MAX_MESSAGE_LENGTH = 200;

const envelopeSchema = z.object({
  retcode: z.number().int(),
  message: z
    .string()
    .catch("")
    .transform((message) => message.slice(0, MAX_MESSAGE_LENGTH)),
  data: z.unknown(),
});
type Envelope = z.infer<typeof envelopeSchema>;

const MALFORMED: FailureResult = {
  kind: "error",
  message: "応答の形式が正しくありません",
};

function httpFailure(
  result: Exclude<HttpResult, { kind: "ok" }>,
): FailureResult {
  switch (result.kind) {
    case "network_error":
      return { kind: "error", message: "通信に失敗しました" };
    case "timeout":
      return { kind: "error", message: "応答がタイムアウトしました" };
    case "http_error":
      return result.status === 429
        ? { kind: "rate_limited" }
        : { kind: "error", message: `HTTP ${String(result.status)}` };
    default: {
      const exhaustive: never = result;
      return exhaustive;
    }
  }
}

/** retcode 0 以外を共通表で分類する。表にない値は API の message を添えて error。 */
export function classifyFailure(envelope: Envelope): FailureResult {
  const kind = COMMON_RETCODES[envelope.retcode];
  console.warn(`hoyo retcode ${String(envelope.retcode)} → ${kind ?? "error"}`);
  if (kind === undefined) {
    const detail = envelope.message || "不明なエラー";
    return {
      kind: "error",
      message: `${detail}（${String(envelope.retcode)}）`,
    };
  }
  return { kind };
}

async function call(
  deps: Deps,
  req: HttpRequest,
): Promise<{ kind: "ok"; envelope: Envelope } | FailureResult> {
  const result = await request(deps, req);
  if (result.kind !== "ok") return httpFailure(result);
  const parsed = envelopeSchema.safeParse(result.json);
  return parsed.success ? { kind: "ok", envelope: parsed.data } : MALFORMED;
}

function checkinUrl(path: "/info" | "/sign"): URL {
  const url = new URL(HOYO.checkin.base + path);
  url.searchParams.set("lang", HOYO.checkin.lang);
  return url;
}

const infoDataSchema = z.object({
  is_sign: z.boolean(),
  total_sign_day: z.number().int().nonnegative(),
});

export type CheckinInfo =
  | {
      readonly kind: "ok";
      readonly isSign: boolean;
      readonly totalSignDay: number;
    }
  | FailureResult;

export async function fetchCheckinInfo(deps: Deps): Promise<CheckinInfo> {
  const url = checkinUrl("/info");
  url.searchParams.set("act_id", HOYO.checkin.actId);
  const res = await call(deps, {
    url,
    method: "GET",
    credentials: "include",
    headers: HOYO.checkin.headers,
  });
  if (res.kind !== "ok") return res;
  if (res.envelope.retcode !== 0) return classifyFailure(res.envelope);
  const data = infoDataSchema.safeParse(res.envelope.data);
  if (!data.success) return MALFORMED;
  return {
    kind: "ok",
    isSign: data.data.is_sign,
    totalSignDay: data.data.total_sign_day,
  };
}

const gtResultSchema = z.object({
  is_risk: z.boolean().optional(),
  risk_code: z.number().optional(),
  gt: z.string().optional(),
  challenge: z.string().optional(),
  success: z.number().optional(),
});
const signDataSchema = z
  .object({ gt_result: gtResultSchema.nullable().optional() })
  .nullable();

/** 公式ページの is_risk と genshin.py の check_for_geetest のどちらかに当たれば CAPTCHA。 */
export function isCaptcha(gt: z.infer<typeof gtResultSchema>): boolean {
  if (gt.is_risk === true) return true;
  return (
    (gt.risk_code ?? 0) !== 0 &&
    Boolean(gt.gt) &&
    Boolean(gt.challenge) &&
    gt.success !== 0
  );
}

export type SignResult =
  | { readonly kind: "claimed" }
  | { readonly kind: "already_claimed" }
  | FailureResult;

export async function signIn(deps: Deps): Promise<SignResult> {
  const res = await call(deps, {
    url: checkinUrl("/sign"),
    method: "POST",
    credentials: "include",
    headers: { ...HOYO.checkin.headers, "content-type": "application/json" },
    body: JSON.stringify({ act_id: HOYO.checkin.actId }),
  });
  if (res.kind !== "ok") return res;
  const { envelope } = res;
  if (envelope.retcode === RETCODE_ALREADY_CLAIMED)
    return { kind: "already_claimed" };
  if (envelope.retcode !== 0) return classifyFailure(envelope);
  const data = signDataSchema.safeParse(envelope.data);
  if (!data.success) return MALFORMED;
  const gt = data.data?.gt_result;
  return gt && isCaptcha(gt) ? { kind: "captcha" } : { kind: "claimed" };
}

const roleEntrySchema = z.object({
  game_biz: z.literal(HOYO.gameBiz),
  game_uid: uidSchema,
  nickname: z.string(),
  level: z.number().int().nonnegative(),
  region: serverSchema,
  region_name: z.string(),
});
const rolesDataSchema = z.object({ list: z.array(z.unknown()) });

export type RolesResult =
  { readonly kind: "ok"; readonly roles: readonly GameRole[] } | FailureResult;

/** 原神（hk4e_global）かつ UID・サーバーが正しい要素だけを GameRole にする。 */
export function parseRoles(list: readonly unknown[]): GameRole[] {
  return list.flatMap((item) => {
    const entry = roleEntrySchema.safeParse(item);
    if (!entry.success) return [];
    const { game_uid, nickname, level, region, region_name } = entry.data;
    return [
      {
        uid: game_uid,
        nickname,
        level,
        server: region,
        serverName: region_name,
      },
    ];
  });
}

export async function fetchRoles(
  deps: Deps,
  domain: Domain,
): Promise<RolesResult> {
  const url = new URL(HOYO.roles[domain]);
  url.searchParams.set("game_biz", HOYO.gameBiz);
  url.searchParams.set("lang", HOYO.roles.lang);
  const res = await call(deps, { url, method: "GET", credentials: "include" });
  if (res.kind !== "ok") return res;
  if (res.envelope.retcode !== 0) return classifyFailure(res.envelope);
  const data = rolesDataSchema.safeParse(res.envelope.data);
  if (!data.success) return MALFORMED;
  return { kind: "ok", roles: parseRoles(data.data.list) };
}

export async function redeemCode(
  deps: Deps,
  role: GameRole,
  code: RedeemCode,
): Promise<RedeemOutcome> {
  const url = new URL(HOYO.redeem.url);
  url.searchParams.set("uid", role.uid);
  url.searchParams.set("region", role.server);
  url.searchParams.set("lang", HOYO.redeem.lang);
  url.searchParams.set("cdkey", code);
  url.searchParams.set("game_biz", HOYO.gameBiz);
  const res = await call(deps, {
    url,
    method: "GET",
    credentials: "include",
    minIntervalMs: HOYO.redeem.minIntervalMs,
  });
  if (res.kind !== "ok") return res;
  const kind = REDEEM_RETCODES[res.envelope.retcode];
  return kind === undefined
    ? classifyFailure(res.envelope)
    : redeemOutcomeOf(kind);
}

function redeemOutcomeOf(
  kind: KindExceptError<RedeemOutcome>,
): RedeemOutcome {
  return { kind };
}

import type { FakeReply } from "./fakes";

/** DESIGN §1 の URL。テストの期待値はコードではなく設計書から取る。 */
export const URL_INFO = "https://sg-act-public-api.hoyolab.com/event/sol/info";
export const URL_SIGN = "https://sg-act-public-api.hoyolab.com/event/sol/sign";
export const URL_ROLES_HOYOLAB =
  "https://api-account-os.hoyolab.com/account/binding/api/getUserGameRolesByCookieToken";
export const URL_ROLES_HOYOVERSE =
  "https://api-account-os.hoyoverse.com/account/binding/api/getUserGameRolesByCookieToken";
export const URL_REDEEM =
  "https://public-operation-hk4e.hoyoverse.com/common/apicdkey/api/webExchangeCdkey";
export const URL_CODES = "https://hoyo-codes.seria.moe/codes";
export const ACT_ID = "e202102251931481";

/** 2026-11-25 12:00 JST。ゲーム内日付は 2026-11-25、既定の受取時刻 01:05 は過ぎている。 */
export const NOON_JST = Date.parse("2026-11-25T03:00:00Z");

export function hoyo(
  retcode: number,
  data: unknown = null,
  message = "",
): FakeReply {
  return { json: { retcode, message, data } };
}

export function info(isSign: boolean, totalSignDay: number): FakeReply {
  return hoyo(0, {
    total_sign_day: totalSignDay,
    today: "2026-11-25",
    is_sign: isSign,
  });
}

export function apiRole(
  uid: string,
  level: number,
  extra: Record<string, unknown> = {},
) {
  return {
    game_biz: "hk4e_global",
    region: "os_asia",
    game_uid: uid,
    nickname: `player${uid.slice(-2)}`,
    level,
    region_name: "Asia Server",
    is_chosen: false,
    is_official: true,
    ...extra,
  };
}

export function roles(...list: unknown[]): FakeReply {
  return hoyo(0, { list });
}

export function codeList(...codes: string[]): FakeReply {
  return {
    json: {
      codes: codes.map((code, i) => ({
        id: i,
        code,
        status: "OK",
        game: "genshin",
        rewards: "",
      })),
      game: "genshin",
    },
  };
}

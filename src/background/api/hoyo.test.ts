import { beforeEach, describe, expect, it } from "vitest";
import { gameRoleSchema } from "../../shared/schema";
import { createTestEnv, type TestEnv } from "../../testing/fakes";
import {
  apiRole,
  hoyo,
  NOON_JST,
  roles,
  URL_CODES,
  URL_INFO,
  URL_REDEEM,
  URL_ROLES_HOYOLAB,
  URL_SIGN,
} from "../../testing/hoyo-replies";
import checkinNotLoggedIn from "./__fixtures__/checkin-info-not-logged-in.json?raw";
import hoyoCodes from "./__fixtures__/hoyo-codes.json?raw";
import redeemNotLoggedIn from "./__fixtures__/redeem-not-logged-in.json?raw";
import rolesNotLoggedIn from "./__fixtures__/roles-not-logged-in.json?raw";
import { fetchCodes, parseCodes } from "./codes";
import { fetchCheckinInfo, fetchRoles, redeemCode, signIn } from "./hoyo";

const fixture = (raw: string): { json: unknown } => ({ json: JSON.parse(raw) });
const ROLE = gameRoleSchema.parse({ uid: "800000001", nickname: "a", level: 1, server: "os_asia", serverName: "Asia" });
const code = (value: string) => {
  const parsed = parseCodes({ codes: [{ code: value, status: "OK", game: "genshin" }] });
  if (parsed.kind !== "ok" || parsed.codes[0] === undefined) throw new Error(value);
  return parsed.codes[0];
};

let env: TestEnv;

beforeEach(() => {
  env = createTestEnv(NOON_JST);
});

describe("記録した実応答", () => {
  it("未ログインのログボ情報（-100）は not_logged_in", async () => {
    env.http.on("GET", URL_INFO, fixture(checkinNotLoggedIn));
    expect(await fetchCheckinInfo(env.deps)).toEqual({ kind: "not_logged_in" });
  });

  it("未ログインのキャラクター一覧（-100）は not_logged_in", async () => {
    env.http.on("GET", URL_ROLES_HOYOLAB, fixture(rolesNotLoggedIn));
    expect(await fetchRoles(env.deps, "hoyolab")).toEqual({ kind: "not_logged_in" });
  });

  it("未ログインの引き換え（-1071）は not_logged_in", async () => {
    env.http.on("GET", URL_REDEEM, fixture(redeemNotLoggedIn));
    expect(await redeemCode(env.deps, ROLE, code("AAA"))).toEqual({ kind: "not_logged_in" });
  });

  it("交換コード一覧から有効な原神コードを取り出し、認証情報を送らない", async () => {
    env.http.on("GET", URL_CODES, fixture(hoyoCodes));

    expect(await fetchCodes(env.deps)).toEqual({
      kind: "ok",
      codes: ["PJ2KEBRAYSRM", "MIJIQ23V2437", "CDOF4X83H7X2", "QYJWFB784MFL", "ARCHONSANSWERS", "POYMANSXF877"],
    });
    expect(env.http.requests[0]?.credentials).toBe("omit");
    expect(env.http.requests[0]?.url.searchParams.get("game")).toBe("genshin");
  });
});

describe("parseCodes", () => {
  it("status・game・形式が違うものを除き、重複を除いて最大50件", () => {
    const valid = Array.from({ length: 60 }, (_, i) => ({ code: `C${String(i)}`, status: "OK", game: "genshin" }));
    const result = parseCodes({
      codes: [
        { code: "EXPIRED1", status: "EXPIRED", game: "genshin" },
        { code: "HSR1", status: "OK", game: "hkrpg" },
        { code: "BAD-CODE", status: "OK", game: "genshin" },
        { code: 123, status: "OK", game: "genshin" },
        { code: "C0", status: "OK", game: "genshin" },
        ...valid,
      ],
    });

    expect(result.kind === "ok" && result.codes.length).toBe(50);
    expect(result.kind === "ok" && result.codes.slice(0, 2)).toEqual(["C0", "C1"]);
  });

  it("一覧の形が違えば error", () => {
    expect(parseCodes({ codes: "x" }).kind).toBe("error");
    expect(parseCodes(null).kind).toBe("error");
  });
});

describe("想定外の応答は例外にせず error に分類する", () => {
  it.each([
    ["envelope に retcode がない", { json: { message: "x" } }],
    ["本文が JSON でない", { json: null }],
    ["info の data が null", hoyo(0, null)],
  ])("info: %s", async (_, reply) => {
    env.http.on("GET", URL_INFO, reply);
    expect((await fetchCheckinInfo(env.deps)).kind).toBe("error");
  });

  it("roles の list が配列でなければ error", async () => {
    env.http.on("GET", URL_ROLES_HOYOLAB, hoyo(0, { list: "x" }));
    expect((await fetchRoles(env.deps, "hoyolab")).kind).toBe("error");
  });

  it("sign の data が想定外の型なら error", async () => {
    env.http.on("POST", URL_SIGN, hoyo(0, "weird"));
    expect((await signIn(env.deps)).kind).toBe("error");
  });

  it("API の message は200文字で切り、履歴や通知に長い文字列を持ち込まない", async () => {
    env.http.on("GET", URL_REDEEM, hoyo(-9999, null, "あ".repeat(5000)));
    const result = await redeemCode(env.deps, ROLE, code("AAA"));
    expect(result).toEqual({ kind: "error", message: `${"あ".repeat(200)}（-9999）` });
  });

  it("表にない retcode は API の message と retcode を添えた error", async () => {
    env.http.on("GET", URL_REDEEM, hoyo(-9999, null, "謎のエラー"));
    expect(await redeemCode(env.deps, ROLE, code("AAA"))).toEqual({ kind: "error", message: "謎のエラー（-9999）" });
  });

  it("HTTP 429 は rate_limited、その他の HTTP エラーは error", async () => {
    env.http.on("POST", URL_SIGN, { json: null, status: 429 });
    expect(await signIn(env.deps)).toEqual({ kind: "rate_limited" });
    env.http.on("GET", URL_ROLES_HOYOLAB, { json: null, status: 403 });
    expect(await fetchRoles(env.deps, "hoyolab")).toEqual({ kind: "error", message: "HTTP 403" });
  });

  it("共通の retcode を分類する", async () => {
    env.http.on("GET", URL_ROLES_HOYOLAB, hoyo(1034), hoyo(10101), roles(apiRole("800000001", 1)));
    expect(await fetchRoles(env.deps, "hoyolab")).toEqual({ kind: "captcha" });
    expect(await fetchRoles(env.deps, "hoyolab")).toEqual({ kind: "rate_limited" });
  });
});

describe("redeemCode の retcode 表（DESIGN §1.3）", () => {
  it.each([
    [0, "redeemed"],
    [-2001, "expired"],
    [-2003, "invalid"],
    [-2004, "invalid"],
    [-2014, "invalid"],
    [-1065, "invalid"],
    [-2006, "usage_limit"],
    [-2008, "region_locked"],
    [-2011, "level_too_low"],
    [-2021, "level_too_low"],
    [-2016, "cooldown"],
    [-2017, "already_redeemed"],
    [-2018, "already_redeemed"],
    [-1073, "no_role"],
    [-1071, "not_logged_in"],
    [-100, "not_logged_in"],
  ])("retcode %i → %s", async (retcode, kind) => {
    env.http.on("GET", URL_REDEEM, hoyo(retcode));
    expect(await redeemCode(env.deps, ROLE, code("AAA"))).toEqual({ kind });
  });
});

describe("fetchCodes の通信失敗", () => {
  it("HTTP エラー・通信失敗は error", async () => {
    env.http.on("GET", URL_CODES, { json: null, status: 404 });
    expect(await fetchCodes(env.deps)).toEqual({ kind: "error", message: "HTTP 404" });
    env.http.on("GET", URL_CODES, { networkError: true });
    expect((await fetchCodes(env.deps)).kind).toBe("error");
  });
});

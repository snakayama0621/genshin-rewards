import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, DEFAULT_STATE } from "../shared/schema";
import type { CodeRecord } from "../shared/types";
import { createFakeFetch, createTestEnv, type TestEnv } from "../testing/fakes";
import {
  apiRole,
  codeList,
  hoyo,
  NOON_JST,
  roles,
  URL_CODES,
  URL_REDEEM,
  URL_ROLES_HOYOLAB,
} from "../testing/hoyo-replies";
import { redeemManually, runRedeemAll } from "./redeem";

const UID = "800000001";
const OTHER_UID = "800000002";

let env: TestEnv;

beforeEach(() => {
  vi.stubEnv("TZ", "Asia/Tokyo");
  env = createTestEnv(NOON_JST);
  env.seed("settings", { ...DEFAULT_SETTINGS, redeemMode: "auto" });
  env.seedRaw("account", {
    roles: [
      {
        uid: UID,
        nickname: "a",
        level: 55,
        server: "os_asia",
        serverName: "Asia",
      },
    ],
    fetchedAt: NOON_JST,
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function record(uid: string, code: string, extra: Partial<CodeRecord> = {}) {
  return {
    code,
    uid,
    status: "redeemed",
    attempts: 1,
    updatedAt: NOON_JST - 1000,
    message: "",
    ...extra,
  };
}

function seedRecords(...records: ReturnType<typeof record>[]): void {
  const codes = Object.fromEntries(
    records.map((r) => [`${r.uid}:${r.code}`, r]),
  );
  env.seedRaw("redeem", { ...DEFAULT_STATE.redeem, codes });
}

const redeemedCodes = () =>
  env.http.to(URL_REDEEM).map((r) => r.url.searchParams.get("cdkey"));

describe("runRedeemAll", () => {
  it("対象UIDで確定済みのコードは送らず、他のUIDの記録は影響しない", async () => {
    seedRecords(
      record(UID, "AAA"),
      record(OTHER_UID, "BBB"),
      record(UID, "CCC", { status: "expired" }),
    );
    env.http.on("GET", URL_CODES, codeList("AAA", "BBB", "CCC"));
    env.http.on("GET", URL_REDEEM, hoyo(0));

    const result = await runRedeemAll(env.deps, "auto");

    expect(redeemedCodes()).toEqual(["BBB"]);
    expect(result).toEqual({
      kind: "done",
      redeemed: 1,
      skipped: 0,
      failed: 0,
    });
  });

  it("公式ギフトページと同じパラメータで6秒間隔に1件ずつ引き換え、結果を保存する", async () => {
    env.http.on("GET", URL_CODES, codeList("AAA", "BBB", "CCC"));
    env.http.on("GET", URL_REDEEM, hoyo(0), hoyo(-2017), hoyo(-2001));

    const result = await runRedeemAll(env.deps, "auto");

    expect(result).toEqual({
      kind: "done",
      redeemed: 1,
      skipped: 2,
      failed: 0,
    });
    expect(env.http.to(URL_REDEEM).map((r) => r.at - NOON_JST)).toEqual([0, 6000, 12000]);
    const [first] = env.http.to(URL_REDEEM);
    expect(Object.fromEntries(first?.url.searchParams ?? [])).toEqual({
      uid: UID,
      region: "os_asia",
      lang: "ja",
      cdkey: "AAA",
      game_biz: "hk4e_global",
    });
    expect(first?.credentials).toBe("include");
    expect(env.http.to(URL_CODES)[0]?.credentials).toBe("omit");

    const state = await env.read("redeem");
    expect(state.available).toEqual(["AAA", "BBB", "CCC"]);
    expect(Object.values(state.codes).map((r) => [r.code, r.status])).toEqual([
      ["AAA", "redeemed"],
      ["BBB", "already_redeemed"],
      ["CCC", "expired"],
    ]);
    expect(state.lastResult).toEqual(result);
    expect(state.lastRunAt).toBe(NOON_JST + 12_000);
    const history = await env.read("history");
    expect(history.map((h) => [h.code, h.outcome])).toEqual([
      ["AAA", "success"],
      ["BBB", "skipped"],
      ["CCC", "skipped"],
    ]);
    expect(env.notices.map((n) => n.message)).toEqual([
      "1 件の交換コードを引き換えました",
    ]);
    expect((await env.read("session")).hoyoverse).toBe("active");
  });

  it("1回の実行で引き換えるのは最大10件", async () => {
    const codes = Array.from({ length: 12 }, (_, i) => `CODE${String(i)}`);
    env.http.on("GET", URL_CODES, codeList(...codes));
    env.http.on("GET", URL_REDEEM, hoyo(0));

    await runRedeemAll(env.deps, "auto");

    expect(redeemedCodes()).toEqual(codes.slice(0, 10));
  });

  it.each([
    [-2016, { kind: "cooldown" }],
    [-1071, { kind: "not_logged_in" }],
    [10035, { kind: "captcha" }],
    [-110, { kind: "rate_limited" }],
  ])(
    "retcode %i を受けたらその時点で止め、そのコードは次回に再試行できるよう記録しない",
    async (retcode, expected) => {
      env.http.on("GET", URL_CODES, codeList("AAA", "BBB"));
      env.http.on("GET", URL_REDEEM, hoyo(retcode));

      const result = await runRedeemAll(env.deps, "auto");

      expect(result).toEqual(expected);
      expect(redeemedCodes()).toEqual(["AAA"]);
      expect((await env.read("redeem")).codes).toEqual({});
    },
  );

  it("未ログイン(-1071)なら HoYoverse を期限切れにして通知する", async () => {
    env.http.on("GET", URL_CODES, codeList("AAA"));
    env.http.on("GET", URL_REDEEM, hoyo(-1071));

    await runRedeemAll(env.deps, "auto");

    expect((await env.read("session")).hoyoverse).toBe("expired");
    expect(env.notices.map((n) => n.id.split(":")[0])).toEqual(["gift-page"]);
  });

  it("error ならそのコードを failed(attempts+1) にして止め、3回失敗したコードは以後送らない", async () => {
    seedRecords(record(UID, "AAA", { status: "failed", attempts: 2 }));
    env.http.on("GET", URL_CODES, codeList("AAA", "BBB"));
    env.http.on("GET", URL_REDEEM, hoyo(-9999, null, "unknown"));

    const result = await runRedeemAll(env.deps, "auto");

    expect(result.kind).toBe("error");
    expect(redeemedCodes()).toEqual(["AAA"]);
    const aaa = (await env.read("redeem")).codes[`${UID}:AAA`];
    expect([aaa?.status, aaa?.attempts]).toEqual(["failed", 3]);
    expect(env.notices.map((n) => n.id.split(":")[0])).toEqual(["options"]);

    env.http.on("GET", URL_REDEEM, hoyo(0));
    const next = await runRedeemAll(env.deps, "auto");

    expect(redeemedCodes()).toEqual(["AAA", "BBB"]);
    expect(next).toEqual({ kind: "done", redeemed: 1, skipped: 0, failed: 1 });
  });

  it("取得元が失敗したら source_error で終わり、引き換えは送らない", async () => {
    env.http.on("GET", URL_CODES, { json: { unexpected: true } });

    const result = await runRedeemAll(env.deps, "auto");

    expect(result.kind).toBe("source_error");
    expect(env.http.to(URL_REDEEM)).toHaveLength(0);
    expect((await env.read("history"))[0]?.outcome).toBe("failure");
  });

  it("原神のキャラクターがいなければ no_role で終わる", async () => {
    env.seed("account", { roles: [], fetchedAt: null });
    env.http.on(
      "GET",
      URL_ROLES_HOYOLAB,
      roles(apiRole("900000001", 60, { game_biz: "hkrpg_global" })),
    );

    const result = await runRedeemAll(env.deps, "auto");

    expect(result).toEqual({ kind: "no_role" });
    expect(env.http.to(URL_CODES)).toHaveLength(0);
    expect((await env.read("redeem")).lastResult).toEqual({ kind: "no_role" });
  });

  it("コードの記録が500件を超えたら updatedAt の古いものから削る", async () => {
    const old = Array.from({ length: 500 }, (_, i) =>
      record(OTHER_UID, `OLD${String(i)}`, { updatedAt: i }),
    );
    seedRecords(...old);
    env.http.on("GET", URL_CODES, codeList("NEW"));
    env.http.on("GET", URL_REDEEM, hoyo(0));

    await runRedeemAll(env.deps, "auto");

    const codes = (await env.read("redeem")).codes;
    expect(Object.keys(codes)).toHaveLength(500);
    expect(codes[`${OTHER_UID}:OLD0`]).toBeUndefined();
    expect(codes[`${OTHER_UID}:OLD1`]).toBeDefined();
    expect(codes[`${UID}:NEW`]?.status).toBe("redeemed");
  });
});

describe("交換APIへの送信間隔", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("一括実行の途中で手動入力の引き換えが重なっても、交換APIへの送信は6秒以上あく", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOON_JST);
    const http = createFakeFetch();
    http.on("GET", URL_CODES, codeList("AAA", "BBB"));
    http.on("GET", URL_REDEEM, hoyo(0));
    const deps = {
      ...env.deps,
      fetch: http.fetch,
      now: () => Date.now(),
      sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    };

    const bulk = runRedeemAll(deps, "auto");
    await vi.advanceTimersByTimeAsync(1000);
    const manual = redeemManually(deps, "CCC");
    await vi.advanceTimersByTimeAsync(60_000);
    await Promise.all([bulk, manual]);

    const times = http.to(URL_REDEEM).map((r) => r.at).toSorted((a, b) => a - b);
    expect(times).toHaveLength(3);
    const gaps = times.slice(1).map((t, i) => t - (times[i] ?? 0));
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(6000);
  });
});

describe("redeemManually", () => {
  it("形式が違うコードは通信しない", async () => {
    expect(await redeemManually(env.deps, "ABC-123")).toEqual({
      kind: "invalid_format",
    });
    expect(await redeemManually(env.deps, "A".repeat(31))).toEqual({
      kind: "invalid_format",
    });
    expect(env.http.requests).toHaveLength(0);
  });

  it("対象UIDで引き換え済みなら通信しない", async () => {
    seedRecords(record(UID, "AAA"));

    expect(await redeemManually(env.deps, "AAA")).toEqual({ kind: "redeemed" });
    expect(env.http.requests).toHaveLength(0);
  });

  it("前後の空白を除いて1件だけ引き換え、記録と履歴を残す", async () => {
    env.http.on("GET", URL_REDEEM, hoyo(0));

    expect(await redeemManually(env.deps, "  GENSHINGIFT \n")).toEqual({
      kind: "redeemed",
    });

    expect(redeemedCodes()).toEqual(["GENSHINGIFT"]);
    expect((await env.read("redeem")).codes[`${UID}:GENSHINGIFT`]?.status).toBe(
      "redeemed",
    );
    const [entry] = await env.read("history");
    expect([entry?.trigger, entry?.code, entry?.outcome]).toEqual([
      "manual",
      "GENSHINGIFT",
      "success",
    ]);
    expect(env.notices).toHaveLength(1);
  });

  it("試行上限に達した failed のコードでも手動なら送る", async () => {
    seedRecords(record(UID, "AAA", { status: "failed", attempts: 3 }));
    env.http.on("GET", URL_REDEEM, hoyo(-2003));

    expect(await redeemManually(env.deps, "AAA")).toEqual({ kind: "invalid" });
    expect((await env.read("redeem")).codes[`${UID}:AAA`]?.status).toBe(
      "invalid",
    );
  });
});

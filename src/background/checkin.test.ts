import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, DEFAULT_STATE, storageSchemas } from "../shared/schema";
import { createTestEnv, type TestEnv } from "../testing/fakes";
import {
  ACT_ID,
  hoyo,
  info,
  NOON_JST,
  URL_INFO,
  URL_SIGN,
} from "../testing/hoyo-replies";
import { runCheckin } from "./checkin";
import { handleAlarm } from "./scheduler";

const TODAY = "2026-11-25";
const THIRTY_MIN = 30 * 60_000;

let env: TestEnv;

beforeEach(() => {
  vi.stubEnv("TZ", "Asia/Tokyo");
  env = createTestEnv(NOON_JST);
  env.seed("settings", { ...DEFAULT_SETTINGS, autoCheckin: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function seedCheckin(state: Record<string, unknown>): void {
  env.seed("checkin", storageSchemas.checkin.parse({ ...DEFAULT_STATE.checkin, ...state }));
}

describe("runCheckin", () => {
  it("当日の受取が記録済みなら一切通信しない", async () => {
    seedCheckin({
      gameDay: TODAY,
      result: { kind: "claimed", totalSignDay: 5 },
      lastRunAt: NOON_JST,
    });

    const result = await runCheckin(env.deps, "manual");

    expect(result).toEqual({ kind: "claimed", totalSignDay: 5 });
    expect(env.http.requests).toHaveLength(0);
  });

  it("前日の受取記録は当日の受取済みとみなさない", async () => {
    seedCheckin({
      gameDay: "2026-11-24",
      result: { kind: "claimed", totalSignDay: 5 },
    });
    env.http.on("GET", URL_INFO, info(true, 6));

    await runCheckin(env.deps, "manual");

    expect(env.http.requests).toHaveLength(1);
  });

  it("is_sign が true なら POST せず already_claimed を記録する", async () => {
    env.http.on("GET", URL_INFO, info(true, 7));

    const result = await runCheckin(env.deps, "manual");

    expect(result).toEqual({ kind: "already_claimed", totalSignDay: 7 });
    expect(env.http.requests.map((r) => r.method)).toEqual(["GET"]);
    const history = await env.read("history");
    expect(history.map((h) => [h.task, h.outcome])).toEqual([
      ["checkin", "skipped"],
    ]);
  });

  it("未受取なら公式ページと同じ POST を送り、total+1 で claimed を保存する", async () => {
    env.http.on("GET", URL_INFO, info(false, 9));
    env.http.on(
      "POST",
      URL_SIGN,
      hoyo(0, {
        code: "ok",
        gt_result: {
          risk_code: 0,
          gt: "",
          challenge: "",
          success: 0,
          is_risk: false,
        },
      }),
    );

    const result = await runCheckin(env.deps, "auto");

    expect(result).toEqual({ kind: "claimed", totalSignDay: 10 });
    const [get, post] = env.http.requests;
    expect(get?.url.searchParams.get("act_id")).toBe(ACT_ID);
    expect(get?.url.searchParams.get("lang")).toBe("ja-jp");
    expect(get?.headers["x-rpc-signgame"]).toBe("hk4e");
    expect(get?.credentials).toBe("include");
    expect(post?.method).toBe("POST");
    expect(`${post?.url.origin ?? ""}${post?.url.pathname ?? ""}`).toBe(
      URL_SIGN,
    );
    expect(post?.url.searchParams.get("lang")).toBe("ja-jp");
    expect(post?.headers["x-rpc-signgame"]).toBe("hk4e");
    expect(post?.credentials).toBe("include");
    expect(JSON.parse(post?.body ?? "")).toEqual({ act_id: ACT_ID });
    // 同じホストへの2件目は1秒あける
    expect(env.sleeps).toEqual([1000]);

    expect(await env.read("checkin")).toEqual({
      gameDay: TODAY,
      result: { kind: "claimed", totalSignDay: 10 },
      autoAttempts: 1,
      lastRunAt: NOON_JST + 1000,
    });
    expect((await env.read("session")).hoyolab).toBe("active");
    expect(env.notices).toHaveLength(1);
    expect(env.notices[0]?.message).toContain("10 日目");
    expect((await env.read("history"))[0]?.outcome).toBe("success");
  });

  it("手動実行は自動試行回数を増やさない", async () => {
    env.http.on("GET", URL_INFO, info(false, 1));
    env.http.on("POST", URL_SIGN, hoyo(0, null));

    await runCheckin(env.deps, "manual");

    expect((await env.read("checkin")).autoAttempts).toBe(0);
  });

  it("retcode -5003 は already_claimed", async () => {
    env.http.on("GET", URL_INFO, info(false, 3));
    env.http.on("POST", URL_SIGN, hoyo(-5003, null, "already"));

    expect(await runCheckin(env.deps, "manual")).toEqual({
      kind: "already_claimed",
      totalSignDay: 4,
    });
    expect(env.notices).toHaveLength(0);
  });

  it.each([
    [
      "公式ページの is_risk",
      { is_risk: true, risk_code: 0, gt: "", challenge: "", success: 0 },
    ],
    [
      "genshin.py の補助判定",
      { risk_code: 5001, gt: "g", challenge: "c", success: 1 },
    ],
  ])(
    "CAPTCHA（%s）なら captcha、再試行アラームなし、失敗通知は公式ページを開く",
    async (_, gtResult) => {
      env.http.on("GET", URL_INFO, info(false, 3));
      env.http.on("POST", URL_SIGN, hoyo(0, { gt_result: gtResult }));

      await handleAlarm(env.deps, "checkin");

      expect((await env.read("checkin")).result).toEqual({ kind: "captcha" });
      expect(env.alarms.has("checkin-retry")).toBe(false);
      expect(env.notices).toHaveLength(1);
      expect(env.notices[0]?.id.startsWith("checkin-page:")).toBe(true);
    },
  );

  it("risk_code が 0 でない場合も success が 0 なら CAPTCHA ではない", async () => {
    env.http.on("GET", URL_INFO, info(false, 3));
    env.http.on(
      "POST",
      URL_SIGN,
      hoyo(0, {
        gt_result: { risk_code: 5001, gt: "g", challenge: "c", success: 0 },
      }),
    );

    expect((await runCheckin(env.deps, "manual")).kind).toBe("claimed");
  });

  it("-100 なら not_logged_in、HoYoLAB を期限切れにし、通知は切れた瞬間の1回だけ", async () => {
    env.http.on("GET", URL_INFO, hoyo(-100, null, "ログインしてください"));

    expect(await runCheckin(env.deps, "manual")).toEqual({
      kind: "not_logged_in",
    });
    expect((await env.read("session")).hoyolab).toBe("expired");
    expect(env.notices.map((n) => n.id.split(":")[0])).toEqual(["hoyolab"]);

    await runCheckin(env.deps, "manual");

    expect(env.http.requests).toHaveLength(2);
    expect(env.notices).toHaveLength(1);
  });

  it("通信失敗なら3回目までは30分後に再試行アラーム、3回目の後は登録せず失敗を通知する", async () => {
    env.http.on("GET", URL_INFO, { networkError: true });

    await handleAlarm(env.deps, "checkin");

    // GET は2秒・4秒待って2回再試行する
    expect(env.http.requests).toHaveLength(3);
    const first = await env.read("checkin");
    expect(first.autoAttempts).toBe(1);
    expect(first.result?.kind).toBe("error");
    expect(env.alarms.get("checkin-retry")?.scheduledTime).toBe(
      (first.lastRunAt ?? 0) + THIRTY_MIN,
    );
    expect(env.notices).toHaveLength(0);

    env.setNow((first.lastRunAt ?? 0) + THIRTY_MIN);
    await handleAlarm(env.deps, "checkin-retry");
    expect((await env.read("checkin")).autoAttempts).toBe(2);
    expect(env.alarms.has("checkin-retry")).toBe(true);

    env.setNow(((await env.read("checkin")).lastRunAt ?? 0) + THIRTY_MIN);
    await handleAlarm(env.deps, "checkin-retry");
    expect((await env.read("checkin")).autoAttempts).toBe(3);
    expect(env.alarms.has("checkin-retry")).toBe(false);
    expect(env.notices.map((n) => n.id.split(":")[0])).toEqual(["options"]);

    const before = env.http.requests.length;
    await handleAlarm(env.deps, "checkin-retry");
    expect(env.http.requests).toHaveLength(before);
  });

  it("captcha の後でも手動実行はでき、自動実行は通信しない", async () => {
    seedCheckin({
      gameDay: TODAY,
      result: { kind: "captcha" },
      autoAttempts: 1,
      lastRunAt: NOON_JST,
    });
    env.http.on("GET", URL_INFO, info(true, 4));

    await handleAlarm(env.deps, "checkin");
    expect(env.http.requests).toHaveLength(0);

    expect(await runCheckin(env.deps, "manual")).toEqual({
      kind: "already_claimed",
      totalSignDay: 4,
    });
    expect(env.http.requests).toHaveLength(1);
  });

  it("応答の data が想定外の形でも例外にせず error として記録する", async () => {
    env.http.on("GET", URL_INFO, hoyo(0, { is_sign: "yes" }));

    expect((await runCheckin(env.deps, "manual")).kind).toBe("error");
    expect((await env.read("checkin")).result?.kind).toBe("error");
  });
});

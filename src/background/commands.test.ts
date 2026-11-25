import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../shared/schema";
import { createTestEnv, type TestEnv } from "../testing/fakes";
import { apiRole, hoyo, info, NOON_JST, roles, URL_INFO, URL_ROLES_HOYOLAB, URL_SIGN } from "../testing/hoyo-replies";
import { handleCommand } from "./commands";

let env: TestEnv;

beforeEach(() => {
  vi.stubEnv("TZ", "Asia/Tokyo");
  env = createTestEnv(NOON_JST);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("handleCommand", () => {
  it.each([
    ["null", null],
    ["未知の type", { type: "deleteEverything" }],
    ["code のない redeemCode", { type: "redeemCode" }],
    ["長すぎる code", { type: "redeemCode", code: "A".repeat(65) }],
  ])("不正なコマンド（%s）は拒否し、何もしない", async (_, raw) => {
    expect(await handleCommand(env.deps, raw)).toEqual({ ok: false, error: "不正なコマンドです" });
    expect(env.http.requests).toHaveLength(0);
  });

  it.each([
    ["間隔 2 時間", { redeemIntervalHours: 2 }],
    ["時刻 25:00", { checkinTime: "25:00" }],
    ["未知の項目", { debug: true }],
    ["型違い", { autoCheckin: "yes" }],
    ["UID の形式違い", { selectedUid: "abc" }],
    ["未知の定期確認モード", { redeemMode: "always" }],
  ])("不正な設定（%s）は保存しない", async (_, patch) => {
    const response = await handleCommand(env.deps, { type: "updateSettings", patch });

    expect(response.ok).toBe(false);
    expect(await env.read("settings")).toEqual(DEFAULT_SETTINGS);
    expect(env.alarms.size).toBe(0);
  });

  it("正しい設定は指定項目だけ保存し、通知設定は部分更新し、アラームを登録し直す", async () => {
    env.seed("account", { roles: [], fetchedAt: NOON_JST });

    const response = await handleCommand(env.deps, {
      type: "updateSettings",
      patch: { redeemMode: "auto", redeemIntervalHours: 12, notifications: { failure: false } },
    });

    expect(response).toEqual({ ok: true, message: "設定を保存しました" });
    expect(await env.read("settings")).toEqual({
      ...DEFAULT_SETTINGS,
      redeemMode: "auto",
      redeemIntervalHours: 12,
      notifications: { ...DEFAULT_SETTINGS.notifications, failure: false },
    });
    expect(env.alarms.get("redeem")?.periodInMinutes).toBe(720);
    // 有効にした定期確認は取りこぼし対策としてすぐ実行される
    await vi.waitFor(async () => {
      expect((await env.read("redeem")).lastResult).toEqual({ kind: "no_role" });
    });
  });

  it("selectedUid に null を指定すると選択を解除する", async () => {
    env.seed("settings", { ...DEFAULT_SETTINGS, selectedUid: null });
    await handleCommand(env.deps, { type: "updateSettings", patch: { selectedUid: "800000001" } });
    expect((await env.read("settings")).selectedUid).toBe("800000001");

    await handleCommand(env.deps, { type: "updateSettings", patch: { selectedUid: null } });
    expect((await env.read("settings")).selectedUid).toBeNull();
  });

  it("checkin は結果を日本語で返す", async () => {
    env.http.on("GET", URL_INFO, info(false, 2));
    env.http.on("POST", URL_SIGN, hoyo(0, null));

    expect(await handleCommand(env.deps, { type: "checkin" })).toEqual({
      ok: true,
      message: "ログインボーナスを受け取りました（今月 3 日目）",
    });
  });

  it("checkin の失敗は ok: false", async () => {
    env.http.on("GET", URL_INFO, hoyo(-100));
    expect(await handleCommand(env.deps, { type: "checkin" })).toEqual({
      ok: false,
      error: "HoYoLABのログインが必要です",
    });
  });

  it("redeemCode の形式違いは通信せずに理由を返す", async () => {
    const response = await handleCommand(env.deps, { type: "redeemCode", code: "ABC-DEF" });
    expect(response).toEqual({ ok: false, error: "交換コードは半角英数字30文字以内です" });
    expect(env.http.requests).toHaveLength(0);
  });

  it("redeemAll でキャラクターがいなければ ok: false", async () => {
    env.seed("account", { roles: [], fetchedAt: NOON_JST });
    expect(await handleCommand(env.deps, { type: "redeemAll" })).toEqual({
      ok: false,
      error: "原神のキャラクターが見つかりません",
    });
  });

  it("refreshAccount は取得結果を返して履歴に残し、60秒以内は通信しない", async () => {
    env.http.on("GET", URL_ROLES_HOYOLAB, roles(apiRole("800000001", 50)));

    expect(await handleCommand(env.deps, { type: "refreshAccount" })).toEqual({
      ok: true,
      message: "キャラクターを 1 件取得しました",
    });
    const again = await handleCommand(env.deps, { type: "refreshAccount" });

    expect(again.ok).toBe(true);
    expect(env.http.requests).toHaveLength(1);
    expect((await env.read("history")).map((h) => [h.task, h.outcome])).toEqual([["account", "success"]]);
  });

  it("clearHistory は履歴を空にする", async () => {
    env.seedRaw("history", [
      { id: "x", at: NOON_JST, task: "checkin", trigger: "auto", outcome: "success", message: "m", code: null },
    ]);
    expect(await handleCommand(env.deps, { type: "clearHistory" })).toEqual({ ok: true, message: "履歴を消去しました" });
    expect(await env.read("history")).toEqual([]);
  });

  it("処理中の例外は ok: false で返す", async () => {
    const broken = { ...env.deps, store: { ...env.deps.store, update: () => Promise.reject(new Error("quota")) } };
    expect(await handleCommand(broken, { type: "clearHistory" })).toEqual({
      ok: false,
      error: "処理中にエラーが発生しました",
    });
  });
});

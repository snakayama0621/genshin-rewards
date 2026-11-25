import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, DEFAULT_STATE } from "../shared/schema";
import { createStore } from "./store";

function memoryStore(initial: Record<string, unknown> = {}) {
  const data = new Map<string, unknown>(Object.entries(initial));
  const store = createStore({
    // 読み書きの間に別の処理が割り込める余地を作る
    read: async (key) => {
      await Promise.resolve();
      return data.get(key);
    },
    write: async (key, value) => {
      await Promise.resolve();
      data.set(key, value);
    },
  });
  return { store, data };
}

describe("createStore", () => {
  it("未保存・不正な値は既定値を返す", async () => {
    const { store } = memoryStore({ session: { hoyolab: "broken" } });
    expect(await store.get("checkin")).toEqual(DEFAULT_STATE.checkin);
    expect(await store.get("session")).toEqual(DEFAULT_STATE.session);
  });

  it("旧形式の autoRedeem: true は引き継がず、定期確認はオフになる", async () => {
    const { store } = memoryStore({ settings: { ...DEFAULT_SETTINGS, redeemMode: undefined, autoRedeem: true } });
    expect((await store.get("settings")).redeemMode).toBe("off");
  });

  it("captchaDay のない旧形式の交換状態も、コードの記録を保ったまま読める", async () => {
    const record = { code: "AAA", uid: "800000001", status: "redeemed", attempts: 1, updatedAt: 1, message: "" };
    const { store } = memoryStore({
      redeem: { codes: { "800000001:AAA": record }, available: ["AAA"], availableFetchedAt: 1, lastRunAt: 1, lastResult: null },
    });

    const state = await store.get("redeem");

    expect(state.codes).toEqual({ "800000001:AAA": record });
    expect(state.captchaDay).toBeNull();
  });

  it("同時の update が直列化され、更新が失われない", async () => {
    const { store } = memoryStore();
    await Promise.all(
      Array.from({ length: 20 }, () =>
        store.update("checkin", (prev) => ({ ...prev, autoAttempts: prev.autoAttempts + 1 })),
      ),
    );
    expect((await store.get("checkin")).autoAttempts).toBe(20);
  });

  it("失敗した update があっても後続の update は実行される", async () => {
    const { store } = memoryStore();
    const failing = store.update("checkin", () => {
      throw new Error("boom");
    });
    const next = store.update("checkin", (prev) => ({ ...prev, autoAttempts: 1 }));
    await expect(failing).rejects.toThrow("boom");
    expect((await next).autoAttempts).toBe(1);
  });
});

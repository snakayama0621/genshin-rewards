import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { describeRedeemRun } from "../shared/labels";
import { DEFAULT_SETTINGS, DEFAULT_STATE } from "../shared/schema";
import { createTestEnv, type TestEnv } from "../testing/fakes";
import { codeList, NOON_JST, URL_CODES, URL_REDEEM } from "../testing/hoyo-replies";
import { runCodeCheck } from "./redeem";

const UID = "800000001";
const OTHER_UID = "800000002";
const ROLE = { nickname: "a", server: "os_asia", serverName: "Asia" };

let env: TestEnv;

beforeEach(() => {
  vi.stubEnv("TZ", "Asia/Tokyo");
  env = createTestEnv(NOON_JST);
  env.seed("settings", { ...DEFAULT_SETTINGS, redeemMode: "notify" });
  env.seedRaw("account", { roles: [{ ...ROLE, uid: UID, level: 55 }], fetchedAt: NOON_JST });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function record(uid: string, code: string, status: string) {
  return { code, uid, status, attempts: 1, updatedAt: NOON_JST - 1000, message: "" };
}

describe("runCodeCheck", () => {
  it("初回は未引き換えのコードを通知し、選択中のUIDで確定済みのコードは除く。引き換えは送らず、履歴も残さない", async () => {
    // 選択中は UID（レベルが低い方）。選択を無視すると OTHER_UID の記録で除外が変わる
    env.seedRaw("account", {
      roles: [
        { ...ROLE, uid: UID, level: 40 },
        { ...ROLE, uid: OTHER_UID, level: 60 },
      ],
      fetchedAt: NOON_JST,
    });
    env.seedRaw("settings", { ...DEFAULT_SETTINGS, redeemMode: "notify", selectedUid: UID });
    env.seedRaw("redeem", {
      ...DEFAULT_STATE.redeem,
      codes: {
        [`${UID}:AAA`]: record(UID, "AAA", "redeemed"),
        [`${OTHER_UID}:BBB`]: record(OTHER_UID, "BBB", "redeemed"),
        [`${UID}:CCC`]: record(UID, "CCC", "failed"),
      },
    });
    env.http.on("GET", URL_CODES, codeList("AAA", "BBB", "CCC", "DDD"));

    expect(await runCodeCheck(env.deps, "auto")).toEqual({ kind: "checked", fresh: 3 });

    expect(env.notices).toEqual([
      { id: "gift-page:id1", title: "新しい交換コード", message: "BBB、CCC、DDD" },
    ]);
    expect(env.http.to(URL_REDEEM)).toHaveLength(0);
    const state = await env.read("redeem");
    expect(state.available).toEqual(["AAA", "BBB", "CCC", "DDD"]);
    expect(state.availableFetchedAt).toBe(NOON_JST);
    expect(state.lastRunAt).toBe(NOON_JST);
    expect(state.lastResult).toEqual({ kind: "checked", fresh: 3 });
    expect(await env.read("history")).toEqual([]);
  });

  it("同じ一覧をもう一度確認しても通知しない", async () => {
    env.http.on("GET", URL_CODES, codeList("AAA", "BBB"));

    await runCodeCheck(env.deps, "auto");
    const second = await runCodeCheck(env.deps, "auto");

    expect(second).toEqual({ kind: "checked", fresh: 0 });
    expect(env.notices).toHaveLength(1);
    expect((await env.read("redeem")).lastResult).toEqual({ kind: "checked", fresh: 0 });
  });

  it("新しく追加されたコードだけを通知する", async () => {
    env.http.on("GET", URL_CODES, codeList("AAA", "BBB"), codeList("AAA", "NEW", "BBB"));

    await runCodeCheck(env.deps, "auto");
    await runCodeCheck(env.deps, "auto");

    expect(env.notices.map((n) => n.message)).toEqual(["AAA、BBB", "NEW"]);
  });

  it("キャラクター未取得でも HoYoverse / HoYoLAB へは通信せず、取得元のコードをすべて通知する（6件目以降は件数だけ）", async () => {
    env.seed("account", { roles: [], fetchedAt: null });
    const codes = Array.from({ length: 7 }, (_, i) => `CODE${String(i)}`);
    env.http.on("GET", URL_CODES, codeList(...codes));

    expect(await runCodeCheck(env.deps, "auto")).toEqual({ kind: "checked", fresh: 7 });

    expect(env.http.requests.map((r) => r.url.host)).toEqual(["hoyo-codes.seria.moe"]);
    expect(env.notices.map((n) => n.message)).toEqual([
      "CODE0、CODE1、CODE2、CODE3、CODE4 ほか 2 件",
    ]);
  });

  it("通知の設定をすべてオフにしていても、新しいコードは通知する", async () => {
    env.seed("settings", {
      ...DEFAULT_SETTINGS,
      redeemMode: "notify",
      notifications: { checkinSuccess: false, redeemSuccess: false, failure: false, sessionExpired: false },
    });
    env.http.on("GET", URL_CODES, codeList("AAA"));

    await runCodeCheck(env.deps, "auto");

    expect(env.notices.map((n) => n.message)).toEqual(["AAA"]);
  });

  it.each([
    [true, ["options"]],
    [false, []],
  ])(
    "取得元が失敗したら source_error を記録して履歴に残し、失敗の通知は設定（%s）に従う",
    async (failure, targets) => {
      env.seed("settings", {
        ...DEFAULT_SETTINGS,
        redeemMode: "notify",
        notifications: { ...DEFAULT_SETTINGS.notifications, failure },
      });
      env.http.on("GET", URL_CODES, { json: { unexpected: true } });

      const result = await runCodeCheck(env.deps, "startup");

      expect(result.kind).toBe("source_error");
      const state = await env.read("redeem");
      expect(state.lastResult).toEqual(result);
      expect(state.availableFetchedAt).toBeNull();
      const history = await env.read("history");
      expect(history.map((h) => [h.task, h.trigger, h.outcome])).toEqual([["redeem", "startup", "failure"]]);
      expect(env.notices.map((n) => n.id.split(":")[0])).toEqual(targets);
    },
  );
});

describe("describeRedeemRun（checked）", () => {
  it("見つかった件数を表示し、0件なら「ありません」と表示する", () => {
    expect(describeRedeemRun({ kind: "checked", fresh: 2 })).toBe("新しいコードが 2 件見つかりました");
    expect(describeRedeemRun({ kind: "checked", fresh: 0 })).toBe("新しいコードはありません");
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, DEFAULT_STATE, isTimeOfDay, storageSchemas } from "../shared/schema";
import { REDEEM_MODES, type CheckinState, type RedeemMode, type Settings } from "../shared/types";
import { createTestEnv, type TestEnv } from "../testing/fakes";
import { codeList, hoyo, info, NOON_JST, URL_CODES, URL_INFO, URL_REDEEM, URL_SIGN } from "../testing/hoyo-replies";
import { handleCommand } from "./commands";
import { ensureAlarms, handleAlarm, isCheckinDue, reconcile } from "./scheduler";

const HOUR = 3_600_000;
const CAPTCHA_RETCODE = 10035;
const at = (iso: string) => Date.parse(iso);

function settings(patch: Partial<Settings> & { time?: string } = {}): Settings {
  const { time, ...rest } = patch;
  const checkinTime = time ?? "01:05";
  if (!isTimeOfDay(checkinTime)) throw new Error(checkinTime);
  return { ...DEFAULT_SETTINGS, autoCheckin: true, checkinTime, ...rest };
}

function checkin(patch: Record<string, unknown> = {}): CheckinState {
  return storageSchemas.checkin.parse({ ...DEFAULT_STATE.checkin, ...patch });
}

let env: TestEnv;

beforeEach(() => {
  vi.stubEnv("TZ", "Asia/Tokyo");
  env = createTestEnv(NOON_JST);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isCheckinDue（UTC+8 の 0 時 = 日本時間 1 時で日付が変わる）", () => {
  const claimedYesterday = checkin({ gameDay: "2026-11-24", result: { kind: "claimed", totalSignDay: 3 } });

  it("日本時間 0:59 はまだ前日扱いで、前日分を受取済みなら実行しない", () => {
    expect(isCheckinDue(settings(), claimedYesterday, at("2026-11-24T15:59:00Z"))).toBe(false);
  });

  it("日付が変わっても指定時刻 01:05 より前は実行しない", () => {
    expect(isCheckinDue(settings(), claimedYesterday, at("2026-11-24T16:04:59Z"))).toBe(false);
  });

  it("指定時刻 01:05 になったら新しい日付分を実行する", () => {
    expect(isCheckinDue(settings(), claimedYesterday, at("2026-11-24T16:05:00Z"))).toBe(true);
  });

  it("指定時刻 00:30 は日付の窓の終わり近く（翌日の 00:30）になる", () => {
    const s = settings({ time: "00:30" });
    expect(isCheckinDue(s, claimedYesterday, NOON_JST)).toBe(false);
    expect(isCheckinDue(s, claimedYesterday, at("2026-11-25T15:30:00Z"))).toBe(true);
  });

  it("自動受取が無効、当日受取済み、当日 captcha、当日3回試行済みなら実行しない", () => {
    const today = { gameDay: "2026-11-25" };
    expect(isCheckinDue(settings({ autoCheckin: false }), checkin(), NOON_JST)).toBe(false);
    expect(isCheckinDue(settings(), checkin({ ...today, result: { kind: "already_claimed", totalSignDay: 1 } }), NOON_JST)).toBe(false);
    expect(isCheckinDue(settings(), checkin({ ...today, result: { kind: "captcha" }, autoAttempts: 1 }), NOON_JST)).toBe(false);
    expect(isCheckinDue(settings(), checkin({ ...today, result: { kind: "rate_limited" }, autoAttempts: 3 }), NOON_JST)).toBe(false);
    expect(isCheckinDue(settings(), checkin({ ...today, result: { kind: "rate_limited" }, autoAttempts: 2 }), NOON_JST)).toBe(true);
  });

  it("前日に3回失敗していても、新しい日付では実行する", () => {
    const failedYesterday = checkin({ gameDay: "2026-11-24", result: { kind: "captcha" }, autoAttempts: 3 });
    expect(isCheckinDue(settings(), failedYesterday, NOON_JST)).toBe(true);
  });
});

const ROLE_ACCOUNT = {
  roles: [{ uid: "800000001", nickname: "a", level: 55, server: "os_asia", serverName: "Asia" }],
  fetchedAt: NOON_JST,
};

describe("起動時の定期確認（reconcile）", () => {
  beforeEach(() => {
    env.seedRaw("account", ROLE_ACCOUNT);
    env.http.on("GET", URL_CODES, codeList());
  });

  it.each(["notify", "auto"] as const)(
    "%s: 未実行、または前回から設定間隔以上たっていれば実行し、間隔内なら実行しない",
    async (redeemMode) => {
      env.seed("settings", settings({ autoCheckin: false, redeemMode, redeemIntervalHours: 3 }));
      // 取得元への送信間隔の待機で偽の時計が進むため、前回実行は現在時刻から数える
      const runsAfter = async (ago: number | null) => {
        const lastRunAt = ago === null ? null : env.deps.now() - ago;
        env.seedRaw("redeem", { ...DEFAULT_STATE.redeem, lastRunAt, lastResult: { kind: "done", redeemed: 0, skipped: 0, failed: 0 } });
        const before = env.http.to(URL_CODES).length;
        await reconcile(env.deps, "startup");
        return env.http.to(URL_CODES).length > before;
      };

      expect(await runsAfter(null)).toBe(true);
      expect(await runsAfter(3 * HOUR)).toBe(true);
      expect(await runsAfter(3 * HOUR - 1)).toBe(false);
    },
  );

  it("オフなら実行しない", async () => {
    env.seed("settings", settings({ autoCheckin: false, redeemMode: "off" }));
    await reconcile(env.deps, "startup");
    expect(env.http.requests).toHaveLength(0);
  });

  it("通知モードから自動に切り替えたら、間隔内でもすぐに引き換える", async () => {
    env.http.on("GET", URL_CODES, codeList("AAA"));
    env.http.on("GET", URL_REDEEM, hoyo(0));
    env.seed("settings", settings({ autoCheckin: false, redeemMode: "notify" }));
    await reconcile(env.deps, "startup");
    expect(env.http.to(URL_REDEEM)).toHaveLength(0);

    env.setNow(NOON_JST + 60_000);
    env.seed("settings", settings({ autoCheckin: false, redeemMode: "auto" }));
    await reconcile(env.deps, "auto");

    expect(env.http.to(URL_REDEEM).map((r) => r.url.searchParams.get("cdkey"))).toEqual(["AAA"]);
  });
});

describe("ensureAlarms", () => {
  it("自動処理がすべて無効なら既存のアラームを消す", async () => {
    await env.deps.alarms.create("checkin", { when: 1 });
    await env.deps.alarms.create("redeem", { when: 1, periodInMinutes: 60 });
    env.seed("settings", DEFAULT_SETTINGS);

    await ensureAlarms(env.deps);

    expect(env.alarms.size).toBe(0);
  });

  it("当日未受取で予定が未来なら当日の予定、受取済みなら翌日の予定に登録する", async () => {
    env.setNow(at("2026-11-24T16:01:00Z")); // 日本時間 11/25 1:01
    env.seed("settings", settings());

    await ensureAlarms(env.deps);
    expect(env.alarms.get("checkin")?.scheduledTime).toBe(at("2026-11-24T16:05:00Z"));

    env.seed("checkin", checkin({ gameDay: "2026-11-25", result: { kind: "claimed", totalSignDay: 1 } }));
    await ensureAlarms(env.deps);
    expect(env.alarms.get("checkin")?.scheduledTime).toBe(at("2026-11-25T16:05:00Z"));
  });

  it("予定を過ぎて未受取なら翌日の予定に登録する（当日分は取りこぼし対策で実行）", async () => {
    env.seed("settings", settings());

    await ensureAlarms(env.deps);

    expect(env.alarms.get("checkin")?.scheduledTime).toBe(at("2026-11-25T16:05:00Z"));
  });

  it.each(REDEEM_MODES)("redeem アラームは定期確認がオフ以外のときだけある（%s）", async (redeemMode: RedeemMode) => {
    await env.deps.alarms.create("redeem", { when: 1, periodInMinutes: 60 });
    env.seed("settings", settings({ autoCheckin: false, redeemMode }));

    await ensureAlarms(env.deps);

    expect(env.alarms.has("redeem")).toBe(redeemMode !== "off");
  });

  it("定期確認は設定間隔の繰り返しアラームで、変化がなければ作り直さない", async () => {
    env.seed("settings", settings({ autoCheckin: false, redeemMode: "auto", redeemIntervalHours: 6 }));

    await ensureAlarms(env.deps);
    await ensureAlarms(env.deps);
    expect(env.alarms.get("redeem")?.periodInMinutes).toBe(360);
    expect(env.alarmOps).toEqual(["create redeem"]);

    env.seed("settings", settings({ autoCheckin: false, redeemMode: "notify", redeemIntervalHours: 1 }));
    await ensureAlarms(env.deps);
    expect(env.alarms.get("redeem")?.periodInMinutes).toBe(60);
    expect(env.alarmOps).toEqual(["create redeem", "create redeem"]);
  });
});

describe("checkin-retry アラーム", () => {
  it("失敗後に実行時刻を遅らせたら、再試行は新しい実行予定時刻より前に鳴らない（過去時刻での空振りを繰り返さない）", async () => {
    // 日本時間 11/25 12:00。01:05 の自動実行が 11:50 に失敗した後、実行時刻を 20:00 に変更した
    env.seed("settings", settings({ time: "20:00" }));
    env.seed(
      "checkin",
      checkin({ gameDay: "2026-11-25", result: { kind: "error", message: "x" }, autoAttempts: 1, lastRunAt: NOON_JST - 10 * 60_000 }),
    );

    await ensureAlarms(env.deps);
    const retryAt = env.alarms.get("checkin-retry")?.scheduledTime;
    expect(retryAt).toBe(at("2026-11-25T11:00:00Z")); // 日本時間 20:00

    if (retryAt === undefined) throw new Error("retry alarm missing");
    env.setNow(retryAt);
    env.http.on("GET", URL_INFO, info(false, 4));
    env.http.on("POST", URL_SIGN, hoyo(0, { gt_result: null }));
    await handleAlarm(env.deps, "checkin-retry");
    expect(env.http.requests.map((r) => r.method)).toEqual(["GET", "POST"]);
  });
});

describe("handleAlarm / reconcile", () => {
  it("起動時、実行すべきログボは startup として即時実行し、間隔内の引き換えは実行しない", async () => {
    env.seed("settings", settings({ redeemMode: "auto" }));
    env.seed("redeem", { ...DEFAULT_STATE.redeem, lastRunAt: NOON_JST - HOUR });
    env.http.on("GET", URL_INFO, info(false, 1));
    env.http.on("POST", URL_SIGN, hoyo(0, null));

    await reconcile(env.deps, "startup");

    expect(env.http.requests.map((r) => r.url.pathname)).toEqual(["/event/sol/info", "/event/sol/sign"]);
    const [entry] = await env.read("history");
    expect(entry?.trigger).toBe("startup");
    expect(env.alarms.has("checkin")).toBe(true);
    expect(env.alarms.has("redeem")).toBe(true);
  });

  it("起動時、間隔を過ぎた自動引き換えを実行する", async () => {
    env.seed("settings", settings({ autoCheckin: false, redeemMode: "auto" }));
    env.seed("account", { roles: [], fetchedAt: NOON_JST });
    env.http.on("GET", URL_CODES, codeList("AAA"));

    await reconcile(env.deps, "startup");

    expect((await env.read("redeem")).lastResult).toEqual({ kind: "no_role" });
  });

  it("30分後の再試行が控えているときは、起動しても前倒しで試さない", async () => {
    env.seed("settings", settings());
    env.seed("checkin", checkin({ gameDay: "2026-11-25", result: { kind: "error", message: "x" }, autoAttempts: 1, lastRunAt: NOON_JST - 60_000 }));

    await reconcile(env.deps, "startup");

    expect(env.http.requests).toHaveLength(0);
    expect(env.alarms.get("checkin-retry")?.scheduledTime).toBe(NOON_JST - 60_000 + 30 * 60_000);
  });

  it("redeem アラームは、オフなら何もせず、自動なら引き換える", async () => {
    env.seed("settings", settings({ autoCheckin: false, redeemMode: "off" }));
    await handleAlarm(env.deps, "redeem");
    expect(env.http.requests).toHaveLength(0);

    env.seed("settings", settings({ autoCheckin: false, redeemMode: "auto" }));
    env.seedRaw("account", ROLE_ACCOUNT);
    env.http.on("GET", URL_CODES, codeList("AAA"));
    env.http.on("GET", URL_REDEEM, hoyo(0));
    await handleAlarm(env.deps, "redeem");
    expect(env.http.to(URL_REDEEM)).toHaveLength(1);
    expect((await env.read("redeem")).lastResult).toEqual({ kind: "done", redeemed: 1, skipped: 0, failed: 0 });
  });

  it("通知モードの redeem アラームはコード一覧の確認だけで、引き換えは送らない", async () => {
    env.seed("settings", settings({ autoCheckin: false, redeemMode: "notify" }));
    env.seedRaw("account", ROLE_ACCOUNT);
    env.http.on("GET", URL_CODES, codeList("AAA"));

    await handleAlarm(env.deps, "redeem");

    expect(env.http.requests.map((r) => r.url.host)).toEqual(["hoyo-codes.seria.moe"]);
    expect((await env.read("redeem")).lastResult).toEqual({ kind: "checked", fresh: 1 });
    expect(env.notices.map((n) => n.message)).toEqual(["AAA"]);
  });

  it("通知モードの今すぐ確認で CAPTCHA が出た日は、通知モードの確認は続き、自動に切り替えても引き換えない", async () => {
    env.seed("settings", settings({ autoCheckin: false, redeemMode: "notify" }));
    env.seedRaw("account", ROLE_ACCOUNT);
    env.http.on("GET", URL_CODES, codeList("AAA"));
    env.http.on("GET", URL_REDEEM, hoyo(CAPTCHA_RETCODE));
    await handleCommand(env.deps, { type: "redeemAll" });
    expect(env.http.to(URL_REDEEM)).toHaveLength(1);

    await handleAlarm(env.deps, "redeem");
    expect(env.http.to(URL_CODES)).toHaveLength(2);

    env.seed("settings", settings({ autoCheckin: false, redeemMode: "auto" }));
    await reconcile(env.deps, "auto");
    await handleAlarm(env.deps, "redeem");
    expect(env.http.to(URL_REDEEM)).toHaveLength(1);
  });

  it("手動入力で CAPTCHA が出た日は自動の引き換えを止め、ゲーム内日付が変わったら再開する", async () => {
    env.seed("settings", settings({ autoCheckin: false, redeemMode: "auto" }));
    env.seedRaw("account", ROLE_ACCOUNT);
    env.http.on("GET", URL_CODES, codeList("AAA"));
    env.http.on("GET", URL_REDEEM, hoyo(CAPTCHA_RETCODE), hoyo(0));
    await handleCommand(env.deps, { type: "redeemCode", code: "BBB" });

    await handleAlarm(env.deps, "redeem");
    expect(env.http.to(URL_REDEEM)).toHaveLength(1);

    env.setNow(NOON_JST + 24 * HOUR);
    await handleAlarm(env.deps, "redeem");
    expect(env.http.to(URL_REDEEM).map((r) => r.url.searchParams.get("cdkey"))).toEqual(["BBB", "AAA"]);
  });

  it("知らない名前のアラームは無視する", async () => {
    await handleAlarm(env.deps, "unknown");
    expect(env.alarmOps).toEqual([]);
  });
});

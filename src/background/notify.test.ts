import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../shared/schema";
import { createTestEnv } from "../testing/fakes";
import { notify, urlForNotification } from "./notify";

const OPTIONS = "chrome-extension://abc/options/options.html";

describe("urlForNotification", () => {
  it("通知IDの種類から固定のURLを選ぶ", () => {
    expect(urlForNotification("checkin-page:1", OPTIONS)).toBe(
      "https://act.hoyolab.com/ys/event/signin-sea-v3/index.html?act_id=e202102251931481",
    );
    expect(urlForNotification("gift-page:1", OPTIONS)).toBe("https://genshin.hoyoverse.com/ja/gift");
    expect(urlForNotification("hoyolab:1", OPTIONS)).toBe("https://www.hoyolab.com/");
    expect(urlForNotification("options:1", OPTIONS)).toBe(OPTIONS);
  });

  it("開く先のない通知・未知のIDは null", () => {
    expect(urlForNotification("none:1", OPTIONS)).toBeNull();
    expect(urlForNotification("https://evil.example/:1", OPTIONS)).toBeNull();
    expect(urlForNotification("toString:1", OPTIONS)).toBeNull();
  });
});

describe("notify", () => {
  it("設定で無効にした種類は通知しない", async () => {
    const env = createTestEnv(0);
    env.seed("settings", { ...DEFAULT_SETTINGS, notifications: { ...DEFAULT_SETTINGS.notifications, failure: false } });

    await notify(env.deps, { setting: "failure", target: "options", title: "t", message: "m" });
    await notify(env.deps, { setting: "checkinSuccess", target: "none", title: "t", message: "m" });

    expect(env.notices).toEqual([{ id: "none:id1", title: "t", message: "m" }]);
  });

  it("setting が null の通知は設定にかかわらず表示する", async () => {
    const env = createTestEnv(0);
    env.seed("settings", {
      ...DEFAULT_SETTINGS,
      notifications: { checkinSuccess: false, redeemSuccess: false, failure: false, sessionExpired: false },
    });

    await notify(env.deps, { setting: null, target: "gift-page", title: "t", message: "m" });

    expect(env.notices).toEqual([{ id: "gift-page:id1", title: "t", message: "m" }]);
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, gameRoleSchema } from "../shared/schema";
import type { GameRole } from "../shared/types";
import { createTestEnv, type TestEnv } from "../testing/fakes";
import {
  apiRole,
  hoyo,
  NOON_JST,
  roles,
  URL_ROLES_HOYOLAB,
  URL_ROLES_HOYOVERSE,
} from "../testing/hoyo-replies";
import { refreshAccount, resolveRole, selectRole } from "./account";

let env: TestEnv;

beforeEach(() => {
  env = createTestEnv(NOON_JST);
});

describe("refreshAccount", () => {
  it("HoYoLAB が -100 なら HoYoverse 側で取得する。HoYoLAB のログイン状態はログボAPIだけで判定するので変えない", async () => {
    env.http.on("GET", URL_ROLES_HOYOLAB, hoyo(-100, null, "Login expired. Please log in again."));
    env.http.on("GET", URL_ROLES_HOYOVERSE, roles(apiRole("800000001", 58)));

    const result = await refreshAccount(env.deps);

    expect(result).toEqual({
      kind: "ok",
      fetched: true,
      roles: [{ uid: "800000001", nickname: "player01", level: 58, server: "os_asia", serverName: "Asia Server" }],
    });
    const [lab, verse] = env.http.requests;
    expect(lab?.url.searchParams.get("game_biz")).toBe("hk4e_global");
    expect(lab?.credentials).toBe("include");
    expect(verse?.url.host).toBe("api-account-os.hoyoverse.com");
    expect(await env.read("session")).toEqual({ hoyolab: "unknown", hoyoverse: "active" });
    expect(env.notices).toEqual([]);
    expect((await env.read("account")).fetchedAt).toBe(NOON_JST);
  });

  it("HoYoLAB で取得できたら HoYoverse 側は呼ばない", async () => {
    env.http.on("GET", URL_ROLES_HOYOLAB, roles(apiRole("800000001", 58)));

    await refreshAccount(env.deps);

    expect(env.http.requests).toHaveLength(1);
  });

  it("原神以外・UID やサーバーの形式が違う要素は除く", async () => {
    env.http.on(
      "GET",
      URL_ROLES_HOYOLAB,
      roles(
        apiRole("800000001", 50),
        apiRole("800000002", 50, { game_biz: "hkrpg_global" }),
        apiRole("12ab", 50),
        apiRole("800000003", 50, { region: "cn_gf01" }),
        apiRole("800000004", -1),
        "garbage",
        null,
      ),
    );

    const result = await refreshAccount(env.deps);

    expect(result.kind === "ok" && result.roles.map((r) => r.uid)).toEqual(["800000001"]);
  });

  it("60秒以内の再取得は通信せず保存済みの一覧を返す", async () => {
    env.http.on("GET", URL_ROLES_HOYOLAB, roles(apiRole("800000001", 50)));
    await refreshAccount(env.deps);

    env.setNow(NOON_JST + 59_999);
    const cached = await refreshAccount(env.deps);
    expect(cached.kind === "ok" && cached.fetched).toBe(false);
    expect(env.http.requests).toHaveLength(1);

    env.setNow(NOON_JST + 60_000);
    await refreshAccount(env.deps);
    expect(env.http.requests).toHaveLength(2);
  });

  it("両方とも未ログインなら not_logged_in を返し、一覧は変えない", async () => {
    env.http.on("GET", URL_ROLES_HOYOLAB, hoyo(-100));
    env.http.on("GET", URL_ROLES_HOYOVERSE, hoyo(-100));

    expect(await refreshAccount(env.deps)).toEqual({ kind: "not_logged_in" });
    expect((await env.read("account")).roles).toEqual([]);
  });

  it("同時に呼ばれても通信は1回だけ", async () => {
    env.http.on("GET", URL_ROLES_HOYOLAB, roles(apiRole("800000001", 50)));

    await Promise.all([refreshAccount(env.deps), refreshAccount(env.deps)]);

    expect(env.http.requests).toHaveLength(1);
  });
});

describe("selectRole / resolveRole", () => {
  const role = (uid: string, level: number): GameRole =>
    gameRoleSchema.parse({ uid, nickname: uid, level, server: "os_asia", serverName: "Asia" });
  const list = [role("800000001", 40), role("800000002", 60), role("800000003", 50)];

  it("selectedUid に一致するキャラクターを選ぶ", () => {
    expect(selectRole(list, list[0]?.uid ?? null)?.uid).toBe("800000001");
  });

  it("selectedUid がない・一致しないなら最もレベルが高いキャラクター", () => {
    expect(selectRole(list, null)?.uid).toBe("800000002");
    expect(selectRole([], null)).toBeNull();
  });

  it("保存済みの一覧があれば通信せずに選ぶ", async () => {
    env.seed("account", { roles: list, fetchedAt: 0 });
    env.seed("settings", { ...DEFAULT_SETTINGS, selectedUid: list[2]?.uid ?? null });

    const resolved = await resolveRole(env.deps);

    expect(resolved.kind === "role" && resolved.role.uid).toBe("800000003");
    expect(env.http.requests).toHaveLength(0);
  });

  it("一覧が空で未ログインなら not_logged_in", async () => {
    env.http.on("GET", URL_ROLES_HOYOLAB, hoyo(-100));
    env.http.on("GET", URL_ROLES_HOYOVERSE, hoyo(-100));

    expect(await resolveRole(env.deps)).toEqual({ kind: "not_logged_in" });
  });
});

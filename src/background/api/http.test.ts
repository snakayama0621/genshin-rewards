import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeFetch, createTestEnv } from "../../testing/fakes";
import { request } from "./http";

const URL_A = "https://example.test/a";
const URL_B = "https://other.test/b";

afterEach(() => {
  vi.useRealTimers();
});

describe("request", () => {
  it("15秒応答がなければ timeout を返す", async () => {
    vi.useFakeTimers();
    const env = createTestEnv(0);
    env.http.on("GET", URL_A, { hang: true });

    const pending = request(env.deps, { url: new URL(URL_A), method: "GET", credentials: "omit" });
    await vi.advanceTimersByTimeAsync(14_999);
    let settled = false;
    void pending.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(await pending).toEqual({ kind: "timeout" });
    // タイムアウトは再試行しない
    expect(env.http.requests).toHaveLength(1);
  });

  it("GET は 5xx なら2秒・4秒待って再試行し、成功した応答を返す", async () => {
    const env = createTestEnv(0);
    env.http.on("GET", URL_A, { json: null, status: 503 }, { json: null, status: 502 }, { json: { ok: 1 } });

    const result = await request(env.deps, { url: new URL(URL_A), method: "GET", credentials: "omit" });

    expect(result).toEqual({ kind: "ok", status: 200, json: { ok: 1 } });
    expect(env.http.requests).toHaveLength(3);
    expect(env.sleeps).toEqual([2000, 4000]);
  });

  it("GET の再試行は最大2回で、最後の失敗を返す", async () => {
    const env = createTestEnv(0);
    env.http.on("GET", URL_A, { networkError: true });

    expect(await request(env.deps, { url: new URL(URL_A), method: "GET", credentials: "omit" })).toEqual({ kind: "network_error" });
    expect(env.http.requests).toHaveLength(3);
  });

  it("4xx は再試行しない", async () => {
    const env = createTestEnv(0);
    env.http.on("GET", URL_A, { json: null, status: 404 });

    expect(await request(env.deps, { url: new URL(URL_A), method: "GET", credentials: "omit" })).toEqual({ kind: "http_error", status: 404 });
    expect(env.http.requests).toHaveLength(1);
  });

  it("POST は失敗しても再試行しない", async () => {
    const env = createTestEnv(0);
    env.http.on("POST", URL_A, { json: null, status: 500 }, { json: {} });

    const result = await request(env.deps, { url: new URL(URL_A), method: "POST", credentials: "include", body: "{}" });

    expect(result).toEqual({ kind: "http_error", status: 500 });
    expect(env.http.requests).toHaveLength(1);
  });

  it("同じホストへ同時に送っても1秒ずつずらし、minIntervalMs を指定すればその間隔をあける", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const http = createFakeFetch();
    http.on("GET", URL_A, { json: {} });
    http.on("GET", URL_B, { json: {} });
    const deps = { fetch: http.fetch, now: () => Date.now(), sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) };
    const get = (url: string, minIntervalMs?: number) =>
      request(deps, { url: new URL(url), method: "GET", credentials: "omit", ...(minIntervalMs === undefined ? {} : { minIntervalMs }) });

    const all = Promise.all([get(URL_A), get(URL_A), get(URL_A), get(URL_B, 6000), get(URL_B, 6000)]);
    await vi.advanceTimersByTimeAsync(10_000);
    await all;

    expect(http.to(URL_A).map((r) => r.at)).toEqual([0, 1000, 2000]);
    expect(http.to(URL_B).map((r) => r.at)).toEqual([0, 6000]);
  });

  it("同じホストへは1秒以上あけ、別のホストは待たない", async () => {
    const env = createTestEnv(10_000);
    env.http.on("GET", URL_A, { json: {} });
    env.http.on("GET", URL_B, { json: {} });
    const get = (url: string) => request(env.deps, { url: new URL(url), method: "GET", credentials: "omit" });

    await get(URL_A);
    await get(URL_B);
    await get(URL_A);
    expect(env.sleeps).toEqual([1000]);

    env.setNow(env.deps.now() + 400);
    await get(URL_A);
    expect(env.sleeps).toEqual([1000, 600]);
  });

  it("本文が JSON でなければ json を null にする", async () => {
    const env = createTestEnv(0);
    const fetchText: typeof fetch = () => Promise.resolve(new Response("<html>", { status: 200 }));

    const result = await request({ ...env.deps, fetch: fetchText }, { url: new URL(URL_A), method: "GET", credentials: "omit" });

    expect(result).toEqual({ kind: "ok", status: 200, json: null });
  });
});

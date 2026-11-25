import type { AlarmInfo, AlarmName, Deps, Notice } from "../background/deps";
import { createStore } from "../background/store";
import type { StorageKey, StorageSchema } from "../shared/types";

export interface RecordedRequest {
  readonly url: URL;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | null;
  readonly credentials: RequestCredentials | undefined;
  /** 送信した時刻（偽の時計） */
  readonly at: number;
}

/** json: 応答本文、networkError: 接続失敗、hang: 中断されるまで応答しない。 */
export type FakeReply =
  | { readonly json: unknown; readonly status?: number }
  | { readonly networkError: true }
  | { readonly hang: true };

function respond(
  reply: FakeReply,
  signal: AbortSignal | null | undefined,
): Promise<Response> {
  if ("networkError" in reply)
    return Promise.reject(new TypeError("fetch failed"));
  if ("hang" in reply) {
    return new Promise((_, reject) => {
      signal?.addEventListener("abort", () => {
        reject(new DOMException("aborted", "AbortError"));
      });
    });
  }
  return Promise.resolve(
    new Response(JSON.stringify(reply.json), { status: reply.status ?? 200 }),
  );
}

/** URL（クエリを除く）とメソッドで応答を返し、受け取ったリクエストをすべて記録する偽の fetch。 */
export function createFakeFetch(clock: () => number = Date.now) {
  const requests: RecordedRequest[] = [];
  const routes = new Map<string, FakeReply[]>();
  const keyOf = (method: string, url: URL) =>
    `${method} ${url.origin}${url.pathname}`;

  const fakeFetch: typeof fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const method = init?.method ?? "GET";
    requests.push({
      url,
      method,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === "string" ? init.body : null,
      credentials: init?.credentials,
      at: clock(),
    });
    const queue = routes.get(keyOf(method, url));
    const reply = queue && queue.length > 1 ? queue.shift() : queue?.[0];
    if (!reply)
      return Promise.reject(
        new Error(`unexpected request ${keyOf(method, url)}`),
      );
    return respond(reply, init?.signal);
  };

  return {
    fetch: fakeFetch,
    requests,
    /** 応答を順に返し、最後の1つは以降も繰り返す。 */
    on(method: "GET" | "POST", url: string, ...replies: FakeReply[]): void {
      routes.set(keyOf(method, new URL(url)), replies);
    },
    to(prefix: string): RecordedRequest[] {
      return requests.filter((req) => req.url.href.startsWith(prefix));
    },
  };
}

export type FakeFetch = ReturnType<typeof createFakeFetch>;

/** 偽の時計（sleep で進む）、メモリ上のストレージ・アラーム・通知を備えた Deps。 */
export function createTestEnv(startAt: number) {
  let now = startAt;
  let nextId = 0;
  const sleeps: number[] = [];
  const data = new Map<StorageKey, unknown>();
  const alarms = new Map<AlarmName, AlarmInfo>();
  const alarmOps: string[] = [];
  const notices: Notice[] = [];
  const http = createFakeFetch(() => now);

  const deps: Deps = {
    fetch: http.fetch,
    now: () => now,
    sleep: (ms) => {
      sleeps.push(ms);
      now += ms;
      return Promise.resolve();
    },
    store: createStore({
      read: (key) => Promise.resolve(data.get(key)),
      write: (key, value) => {
        data.set(key, structuredClone(value));
        return Promise.resolve();
      },
    }),
    alarms: {
      create: (name, spec) => {
        alarmOps.push(`create ${name}`);
        alarms.set(name, {
          scheduledTime: spec.when,
          ...(spec.periodInMinutes === undefined
            ? {}
            : { periodInMinutes: spec.periodInMinutes }),
        });
        return Promise.resolve();
      },
      clear: (name) => {
        alarmOps.push(`clear ${name}`);
        alarms.delete(name);
        return Promise.resolve();
      },
      get: (name) => Promise.resolve(alarms.get(name)),
    },
    notifier: {
      show: (notice) => {
        notices.push(notice);
        return Promise.resolve();
      },
    },
    randomId: () => `id${String((nextId += 1))}`,
  };

  return {
    deps,
    http,
    sleeps,
    alarms,
    alarmOps,
    notices,
    setNow(at: number) {
      now = at;
    },
    seed<K extends StorageKey>(key: K, value: StorageSchema[K]) {
      data.set(key, structuredClone(value));
    },
    seedRaw(key: StorageKey, value: unknown) {
      data.set(key, value);
    },
    read<K extends StorageKey>(key: K): Promise<StorageSchema[K]> {
      return deps.store.get(key);
    },
  };
}

export type TestEnv = ReturnType<typeof createTestEnv>;

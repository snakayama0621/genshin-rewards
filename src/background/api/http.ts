import type { Deps } from "../deps";

export const REQUEST_TIMEOUT_MS = 15_000;
export const GET_RETRY_WAITS_MS = [2_000, 4_000] as const;
export const MIN_HOST_INTERVAL_MS = 1_000;

export type HttpResult =
  | { readonly kind: "ok"; readonly status: number; readonly json: unknown }
  | { readonly kind: "network_error" }
  | { readonly kind: "http_error"; readonly status: number }
  | { readonly kind: "timeout" };

export interface HttpRequest {
  readonly url: URL;
  readonly method: "GET" | "POST";
  readonly credentials: RequestCredentials;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  /** 同じホストへの送信間隔。省略時は MIN_HOST_INTERVAL_MS */
  readonly minIntervalMs?: number;
}

type HttpDeps = Pick<Deps, "fetch" | "now" | "sleep">;

// ホストごとの最終送信時刻。Service Worker 内で共有するため fetch 実装ごとに保持する
// （テストでは偽の fetch ごとに独立する）。
const lastSentAt = new WeakMap<typeof fetch, Map<string, number>>();

/** 送信枠を待つ前に同期的に予約するので、同時に呼ばれても間隔が守られる。 */
async function waitForHost(deps: HttpDeps, req: HttpRequest): Promise<void> {
  const host = req.url.host;
  const byHost = lastSentAt.get(deps.fetch) ?? new Map<string, number>();
  lastSentAt.set(deps.fetch, byHost);
  const now = deps.now();
  const last = byHost.get(host);
  const interval = req.minIntervalMs ?? MIN_HOST_INTERVAL_MS;
  const slot = last === undefined ? now : Math.max(now, last + interval);
  byHost.set(host, slot);
  if (slot > now) await deps.sleep(slot - now);
}

async function sendOnce(deps: HttpDeps, req: HttpRequest): Promise<HttpResult> {
  await waitForHost(deps, req);
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  try {
    const response = await deps.fetch(req.url, {
      method: req.method,
      credentials: req.credentials,
      headers: { ...req.headers },
      body: req.body ?? null,
      signal: controller.signal,
    });
    if (!response.ok) return { kind: "http_error", status: response.status };
    // 本文がJSONでなければ null とし、呼び出し側の形式検証で error になる
    const json: unknown = await response.json().catch(() => null);
    return { kind: "ok", status: response.status, json };
  } catch {
    return controller.signal.aborted
      ? { kind: "timeout" }
      : { kind: "network_error" };
  } finally {
    clearTimeout(timer);
  }
}

function isRetryable(result: HttpResult): boolean {
  return (
    result.kind === "network_error" ||
    (result.kind === "http_error" && result.status >= 500)
  );
}

/** GET はネットワークエラーと 5xx のみ最大2回再試行する。POST は再試行しない。 */
export async function request(
  deps: HttpDeps,
  req: HttpRequest,
): Promise<HttpResult> {
  const waits = req.method === "GET" ? GET_RETRY_WAITS_MS : [];
  let result = await sendOnce(deps, req);
  for (const wait of waits) {
    if (!isRetryable(result)) break;
    await deps.sleep(wait);
    result = await sendOnce(deps, req);
  }
  return result;
}

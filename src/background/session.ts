import type { SessionStatus } from "../shared/types";
import type { Domain } from "./api/hoyo";
import type { Deps } from "./deps";
import { notify } from "./notify";

const EXPIRED_NOTICE = {
  hoyolab: {
    target: "hoyolab",
    message: "HoYoLABのログインが切れました。ログインし直してください",
  },
  hoyoverse: {
    target: "gift-page",
    message: "公式交換サイト（HoYoverse）のログインが切れました。ログインし直してください",
  },
} as const;

/** 応答の種類からログイン状態を読み取る。判断できない失敗は null（状態を変えない）。 */
export function sessionStatusOf(kind: string): SessionStatus | null {
  switch (kind) {
    case "not_logged_in":
      return "expired";
    case "error":
    case "rate_limited":
    case "captcha":
      return null;
    default:
      return "active";
  }
}

/** 状態を更新し、expired へ変わった瞬間だけ通知する。 */
export async function observeSession(
  deps: Deps,
  domain: Domain,
  resultKind: string,
): Promise<void> {
  const next = sessionStatusOf(resultKind);
  if (next === null) return;
  const seen: { previous: SessionStatus } = { previous: "unknown" };
  await deps.store.update("session", (prev) => {
    seen.previous = prev[domain];
    return { ...prev, [domain]: next };
  });
  if (next !== "expired" || seen.previous === "expired") return;
  await notify(deps, {
    setting: "sessionExpired",
    title: "ログインが必要です",
    ...EXPIRED_NOTICE[domain],
  });
}

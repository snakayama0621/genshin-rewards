import type { FailureResult, GameRole, Uid } from "../shared/types";
import { fetchRoles, type RolesResult } from "./api/hoyo";
import type { Deps } from "./deps";
import { observeSession } from "./session";
import { singleFlight } from "./single-flight";

export const ACCOUNT_THROTTLE_MS = 60_000;

export type AccountResult =
  | {
      readonly kind: "ok";
      readonly roles: readonly GameRole[];
      /** false なら60秒以内の取得結果を通信せずに返した */
      readonly fetched: boolean;
    }
  | FailureResult;

export type RoleResolution =
  | { readonly kind: "role"; readonly role: GameRole }
  | { readonly kind: "no_role" }
  | FailureResult;

async function fetchFromDomains(deps: Deps): Promise<RolesResult> {
  const hoyolab = await fetchRoles(deps, "hoyolab");
  // このAPIがHoYoLABのログインで使えるかは未検証のため、-100 ではHoYoLABの状態を変えない
  if (hoyolab.kind !== "not_logged_in") {
    await observeSession(deps, "hoyolab", hoyolab.kind);
    return hoyolab;
  }
  const hoyoverse = await fetchRoles(deps, "hoyoverse");
  await observeSession(deps, "hoyoverse", hoyoverse.kind);
  return hoyoverse;
}

/**
 * HoYoLAB → HoYoverse の順にキャラクター一覧を取得する。
 * 失敗も含めて60秒に1回までに抑えるため、fetchedAt は試行時刻を表す。
 */
export const refreshAccount = singleFlight(
  async (deps: Deps): Promise<AccountResult> => {
    const now = deps.now();
    const account = await deps.store.get("account");
    if (account.fetchedAt !== null && now - account.fetchedAt < ACCOUNT_THROTTLE_MS) {
      return { kind: "ok", roles: account.roles, fetched: false };
    }
    const result = await fetchFromDomains(deps);
    await deps.store.update("account", (prev) =>
      result.kind === "ok"
        ? { roles: result.roles, fetchedAt: now }
        : { ...prev, fetchedAt: now },
    );
    return result.kind === "ok"
      ? { kind: "ok", roles: result.roles, fetched: true }
      : result;
  },
);

/** settings.selectedUid に一致するキャラクター、なければ最もレベルが高いもの。 */
export function selectRole(
  roles: readonly GameRole[],
  selectedUid: Uid | null,
): GameRole | null {
  const selected = roles.find((role) => role.uid === selectedUid);
  if (selected) return selected;
  return roles.reduce<GameRole | null>(
    (best, role) => (best === null || role.level > best.level ? role : best),
    null,
  );
}

export async function resolveRole(deps: Deps): Promise<RoleResolution> {
  const account = await deps.store.get("account");
  let roles = account.roles;
  if (roles.length === 0) {
    const refreshed = await refreshAccount(deps);
    if (refreshed.kind !== "ok") return refreshed;
    roles = refreshed.roles;
  }
  const settings = await deps.store.get("settings");
  const role = selectRole(roles, settings.selectedUid);
  return role ? { kind: "role", role } : { kind: "no_role" };
}

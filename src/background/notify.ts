import type { NotificationSettings } from "../shared/types";
import { OFFICIAL_PAGES } from "../shared/links";
import type { Deps } from "./deps";

const EXTERNAL_PAGES = {
  "checkin-page": OFFICIAL_PAGES.checkinPage,
  "gift-page": OFFICIAL_PAGES.gift,
  hoyolab: OFFICIAL_PAGES.hoyolab,
} as const;

/** 通知をクリックしたときに開く先。通知IDの先頭に埋め込む。 */
export type NoticeTarget = keyof typeof EXTERNAL_PAGES | "options" | "none";

export interface NoticeRequest {
  /** null は常に表示する（利用者が通知モードを選んだこと自体が許可にあたる）。 */
  readonly setting: keyof NotificationSettings | null;
  readonly target: NoticeTarget;
  readonly title: string;
  readonly message: string;
}

function isExternalPage(value: string): value is keyof typeof EXTERNAL_PAGES {
  return Object.hasOwn(EXTERNAL_PAGES, value);
}

/** 通知IDから開くURLを固定の表で決める。外部データは使わない。 */
export function urlForNotification(id: string, optionsUrl: string): string | null {
  const target = id.split(":", 1)[0] ?? "";
  if (target === "options") return optionsUrl;
  return isExternalPage(target) ? EXTERNAL_PAGES[target] : null;
}

export async function notify(deps: Deps, req: NoticeRequest): Promise<void> {
  const settings = await deps.store.get("settings");
  if (req.setting !== null && !settings.notifications[req.setting]) return;
  await deps.notifier.show({
    id: `${req.target}:${deps.randomId()}`,
    title: req.title,
    message: req.message,
  });
}

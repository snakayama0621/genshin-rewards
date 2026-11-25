import {
  REDEEM_MODE_LABEL,
  SESSION_VIEW,
  type StatusView,
  type Tone,
} from "../shared/labels";
import { OFFICIAL_PAGES, type OfficialPage } from "../shared/links";
import { isUid, type SettingsPatch } from "../shared/schema";
import { readAllState, sendCommand } from "../shared/storage";
import {
  REDEEM_MODES,
  type Command,
  type CommandResponse,
  type GameRole,
  type RedeemMode,
  type SessionState,
  type StorageSchema,
  type Uid,
} from "../shared/types";
import { h } from "./dom";


const TONE_GLYPH: Readonly<Record<Tone, string>> = {
  success: "✓",
  warning: "!",
  danger: "×",
  neutral: "・",
};

export function chip(view: StatusView): HTMLSpanElement {
  return h(
    "span",
    { class: "chip", "data-tone": view.tone },
    h(
      "span",
      { class: "chip-glyph", "aria-hidden": "true" },
      TONE_GLYPH[view.tone],
    ),
    view.label,
  );
}

export function externalLink(key: OfficialPage, text: string): HTMLAnchorElement {
  return h(
    "a",
    { href: OFFICIAL_PAGES[key], target: "_blank", rel: "noopener noreferrer" },
    text,
  );
}

const SESSION_ROWS = [
  { name: "HoYoLAB", key: "hoyolab", link: "hoyolab" },
  { name: "交換サイト", key: "hoyoverse", link: "gift" },
] as const;

/** One row per login (HoYoLAB / gift site) with a login link when expired. */
export function sessionRows(session: SessionState): HTMLElement[] {
  return SESSION_ROWS.map(({ name, key, link }) =>
    h(
      "div",
      { class: "session-row" },
      h("span", { class: "session-name" }, name),
      chip(SESSION_VIEW[session[key]]),
      session[key] === "expired" && externalLink(link, `${name}にログイン`),
    ),
  );
}

export function roleLabel(role: GameRole): string {
  return `${role.nickname}（UID ${role.uid}・${role.serverName}・Lv.${String(role.level)}）`;
}

export function fillRoleSelect(
  select: HTMLSelectElement,
  roles: readonly GameRole[],
  selected: GameRole | null,
): void {
  select.replaceChildren(
    ...roles.map((role) => h("option", { value: role.uid }, roleLabel(role))),
  );
  if (selected) select.value = selected.uid;
}

export function selectedUidOf(select: HTMLSelectElement): Uid | null {
  return isUid(select.value) ? select.value : null;
}

export function fillRedeemModeSelect(select: HTMLSelectElement): void {
  select.replaceChildren(
    ...REDEEM_MODES.map((mode) =>
      h("option", { value: mode }, REDEEM_MODE_LABEL[mode]),
    ),
  );
}

export function redeemModeOf(select: HTMLSelectElement): RedeemMode | null {
  return REDEEM_MODES.find((mode) => mode === select.value) ?? null;
}

export interface AlarmTimes {
  readonly checkin: number | undefined;
  readonly redeem: number | undefined;
}

export async function loadAlarmTimes(): Promise<AlarmTimes> {
  const [checkin, redeem] = await Promise.all([
    chrome.alarms.get("checkin"),
    chrome.alarms.get("redeem"),
  ]);
  return {
    checkin: checkin?.scheduledTime,
    redeem: redeem?.scheduledTime,
  };
}

export interface LoadedState {
  readonly state: StorageSchema;
  readonly alarms: AlarmTimes;
}

export async function loadState(): Promise<LoadedState> {
  const [state, alarms] = await Promise.all([readAllState(), loadAlarmTimes()]);
  return { state, alarms };
}

export function showResult(
  output: HTMLElement,
  response: CommandResponse,
): void {
  output.textContent = response.ok ? response.message : response.error;
  output.dataset.tone = response.ok ? "success" : "danger";
}

export function showError(output: HTMLElement, message: string): void {
  output.textContent = message;
  output.dataset.tone = "danger";
}

/** Runs a command from a button: disables it with a spinner, then shows the response inline. */
export async function runFromButton(
  button: HTMLButtonElement,
  output: HTMLElement,
  command: Command,
  pendingLabel: string,
): Promise<CommandResponse> {
  const idleChildren = [...button.childNodes];
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  button.replaceChildren(
    h("span", { class: "spinner", "aria-hidden": "true" }),
    pendingLabel,
  );
  output.textContent = "";
  try {
    const response = await sendCommand(command);
    showResult(output, response);
    return response;
  } finally {
    button.replaceChildren(...idleChildren);
    button.removeAttribute("aria-busy");
    button.disabled = false;
  }
}

/**
 * Sends only the changed settings. On failure shows the error and calls `rerender`
 * so the controls snap back to what storage holds.
 */
export async function updateSettings(
  patch: SettingsPatch,
  output: HTMLElement,
  rerender: () => Promise<void>,
): Promise<void> {
  const response = await sendCommand({ type: "updateSettings", patch });
  if (response.ok) {
    output.textContent = "";
    return;
  }
  showError(output, response.error);
  await rerender();
}

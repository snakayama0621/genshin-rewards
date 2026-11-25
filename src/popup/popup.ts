import { describeRedeemRun, OUTCOME_VIEW, TASK_LABEL } from "../shared/labels";
import { isRedeemCode } from "../shared/schema";
import { onStateChanged, sendCommand } from "../shared/storage";
import { gameDayOf } from "../shared/time";
import type { HistoryEntry, Uid } from "../shared/types";
import {
  chip,
  fillRedeemModeSelect,
  externalLink,
  fillRoleSelect,
  loadState,
  redeemModeOf,
  runFromButton,
  selectedUidOf,
  sessionRows,
  showError,
  updateSettings,
  type LoadedState,
} from "../ui/components";
import { byId, h } from "../ui/dom";
import {
  formatLastRun,
  formatNextRun,
  formatShortDateTime,
} from "../ui/format";
import {
  checkinView,
  recentHistory,
  redeemSummaryView,
  selectRole,
  shouldRefreshAccount,
} from "../ui/view-model";

const COPY_FEEDBACK_MS = 2000;

const el = {
  openOptions: byId("open-options", HTMLButtonElement),
  roleInfo: byId("role-info", HTMLDivElement),
  roleName: byId("role-name", HTMLParagraphElement),
  roleUid: byId("role-uid", HTMLSpanElement),
  copyUid: byId("copy-uid", HTMLButtonElement),
  copyFeedback: byId("copy-feedback", HTMLSpanElement),
  roleServer: byId("role-server", HTMLParagraphElement),
  roleSelectRow: byId("role-select-row", HTMLDivElement),
  roleSelect: byId("role-select", HTMLSelectElement),
  roleEmpty: byId("role-empty", HTMLDivElement),
  roleEmptyLinks: byId("role-empty-links", HTMLParagraphElement),
  sessions: byId("sessions", HTMLDivElement),
  accountResult: byId("account-result", HTMLParagraphElement),
  checkinChip: byId("checkin-chip", HTMLSpanElement),
  checkinDetail: byId("checkin-detail", HTMLParagraphElement),
  checkinCaptcha: byId("checkin-captcha", HTMLParagraphElement),
  checkinLast: byId("checkin-last", HTMLElement),
  checkinNext: byId("checkin-next", HTMLElement),
  autoCheckin: byId("auto-checkin", HTMLInputElement),
  checkinRun: byId("checkin-run", HTMLButtonElement),
  checkinResult: byId("checkin-result", HTMLParagraphElement),
  redeemChip: byId("redeem-chip", HTMLSpanElement),
  redeemLast: byId("redeem-last", HTMLElement),
  redeemNext: byId("redeem-next", HTMLElement),
  redeemDetail: byId("redeem-detail", HTMLParagraphElement),
  redeemMode: byId("redeem-mode", HTMLSelectElement),
  redeemRun: byId("redeem-run", HTMLButtonElement),
  redeemResult: byId("redeem-result", HTMLParagraphElement),
  codeForm: byId("code-form", HTMLFormElement),
  codeInput: byId("code-input", HTMLInputElement),
  codeSubmit: byId("code-submit", HTMLButtonElement),
  codeResult: byId("code-result", HTMLParagraphElement),
  noteOptions: byId("note-options", HTMLButtonElement),
  historyList: byId("history-list", HTMLUListElement),
  openHistory: byId("open-history", HTMLButtonElement),
};

let copyTimer: ReturnType<typeof setTimeout> | undefined;
let shownUid: Uid | null = null;

function render({ state, alarms }: LoadedState): void {
  const now = Date.now();
  const { settings, account, checkin, redeem } = state;
  const role = selectRole(account.roles, settings.selectedUid);

  shownUid = role?.uid ?? null;
  el.roleInfo.hidden = role === null;
  el.roleEmpty.hidden = role !== null;
  if (role) {
    el.roleName.textContent = role.nickname;
    el.roleUid.textContent = `UID ${role.uid}`;
    el.roleServer.textContent = `${role.serverName}・冒険ランク ${String(role.level)}`;
  }
  el.roleSelectRow.hidden = account.roles.length <= 1;
  fillRoleSelect(el.roleSelect, account.roles, role);
  el.sessions.replaceChildren(...sessionRows(state.session));

  const checkinState = checkinView(checkin, gameDayOf(now));
  el.checkinChip.replaceChildren(chip(checkinState.status));
  el.checkinDetail.textContent = checkinState.detail;
  el.checkinCaptcha.hidden = checkinState.display !== "captcha";
  el.checkinLast.textContent = formatLastRun(checkin.lastRunAt);
  el.checkinNext.textContent = formatNextRun(
    settings.autoCheckin,
    alarms.checkin,
    "自動受取オフ",
  );
  el.autoCheckin.checked = settings.autoCheckin;

  el.redeemChip.replaceChildren(
    chip(redeemSummaryView(redeem, role?.uid ?? null)),
  );
  el.redeemLast.textContent = formatLastRun(redeem.lastRunAt);
  el.redeemDetail.textContent =
    redeem.lastResult === null ? "" : describeRedeemRun(redeem.lastResult);
  el.redeemNext.textContent = formatNextRun(
    settings.redeemMode !== "off",
    alarms.redeem,
    "定期確認オフ",
  );
  el.redeemMode.value = settings.redeemMode;

  const recent = recentHistory(state.history);
  el.historyList.replaceChildren(
    ...(recent.length === 0
      ? [h("li", { class: "empty" }, "まだ履歴はありません")]
      : recent.map(historyItem)),
  );
}

function historyItem(entry: HistoryEntry): HTMLLIElement {
  return h(
    "li",
    { class: "history-item" },
    h(
      "div",
      { class: "history-head" },
      h(
        "time",
        { datetime: new Date(entry.at).toISOString() },
        formatShortDateTime(entry.at),
      ),
      h("span", { class: "history-task" }, TASK_LABEL[entry.task]),
      chip(OUTCOME_VIEW[entry.outcome]),
    ),
    h(
      "p",
      { class: "history-message" },
      entry.message,
      entry.code !== null && h("code", { class: "code" }, entry.code),
    ),
  );
}

async function refresh(): Promise<void> {
  render(await loadState());
}

function openOptions(): void {
  void chrome.runtime.openOptionsPage();
}

async function copyUid(): Promise<void> {
  if (shownUid === null) return;
  try {
    await navigator.clipboard.writeText(shownUid);
    el.copyFeedback.textContent = "コピーしました";
  } catch {
    el.copyFeedback.textContent = "コピーできませんでした";
  }
  clearTimeout(copyTimer);
  copyTimer = setTimeout(() => {
    el.copyFeedback.textContent = "";
  }, COPY_FEEDBACK_MS);
}

async function redeemTypedCode(): Promise<void> {
  const code = el.codeInput.value.trim();
  if (!isRedeemCode(code)) {
    showError(
      el.codeResult,
      "交換コードは半角英数字30文字以内で入力してください",
    );
    el.codeInput.focus();
    return;
  }
  const response = await runFromButton(
    el.codeSubmit,
    el.codeResult,
    { type: "redeemCode", code },
    "引き換え中…",
  );
  if (response.ok) el.codeInput.value = "";
}

function wire(): void {
  fillRedeemModeSelect(el.redeemMode);
  el.openOptions.addEventListener("click", openOptions);
  el.noteOptions.addEventListener("click", openOptions);
  el.openHistory.addEventListener("click", openOptions);
  el.copyUid.addEventListener("click", () => {
    void copyUid();
  });
  el.roleSelect.addEventListener("change", () => {
    void updateSettings(
      { selectedUid: selectedUidOf(el.roleSelect) },
      el.accountResult,
      refresh,
    );
  });
  el.autoCheckin.addEventListener("change", () => {
    void updateSettings(
      { autoCheckin: el.autoCheckin.checked },
      el.checkinResult,
      refresh,
    );
  });
  el.redeemMode.addEventListener("change", () => {
    const redeemMode = redeemModeOf(el.redeemMode);
    if (redeemMode === null) return;
    void updateSettings({ redeemMode }, el.redeemResult, refresh);
  });
  el.checkinRun.addEventListener("click", () => {
    void runFromButton(
      el.checkinRun,
      el.checkinResult,
      { type: "checkin" },
      "受取中…",
    ).then(refresh);
  });
  el.redeemRun.addEventListener("click", () => {
    void runFromButton(
      el.redeemRun,
      el.redeemResult,
      { type: "redeemAll" },
      "確認中…",
    ).then(refresh);
  });
  el.codeForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void redeemTypedCode();
  });
  el.roleEmptyLinks.replaceChildren(
    externalLink("hoyolab", "HoYoLABを開く"),
    externalLink("gift", "公式交換サイトを開く"),
  );
  el.checkinCaptcha.replaceChildren(
    externalLink("checkinPage", "公式ページで受け取る"),
    "（受け取った後は「今すぐ受取」で状態を更新できます）",
  );
  onStateChanged(() => {
    void refresh();
  });
}

async function main(): Promise<void> {
  wire();
  const loaded = await loadState();
  render(loaded);
  if (shouldRefreshAccount(loaded.state.account, Date.now())) {
    const response = await sendCommand({ type: "refreshAccount" });
    if (!response.ok) showError(el.accountResult, response.error);
  }
}

void main();

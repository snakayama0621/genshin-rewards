import {
  CODE_STATUS_VIEW,
  OUTCOME_VIEW,
  TASK_LABEL,
  TRIGGER_LABEL,
} from "../shared/labels";
import { isTimeOfDay } from "../shared/schema";
import { onStateChanged } from "../shared/storage";
import {
  REDEEM_INTERVAL_HOURS,
  type CodeRecord,
  type HistoryEntry,
  type HistoryOutcome,
  type NotificationSettings,
  type TaskName,
} from "../shared/types";
import {
  chip,
  fillRedeemModeSelect,
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
import { formatDateTime, formatLastRun, formatNextRun } from "../ui/format";
import {
  codeRecordsFor,
  filterHistory,
  selectRole,
  type HistoryFilter,
} from "../ui/view-model";

const NOTIFICATION_LABEL: Readonly<Record<keyof NotificationSettings, string>> =
  {
    checkinSuccess: "ログインボーナスを受け取ったとき",
    redeemSuccess: "交換コードを引き換えたとき",
    failure: "失敗したとき（セキュリティ認証を含む）",
    sessionExpired: "ログインが切れたとき",
  };
const NOTIFICATION_KEYS = Object.keys(
  NOTIFICATION_LABEL,
) as (keyof NotificationSettings)[];
const TASKS = Object.keys(TASK_LABEL) as TaskName[];
const OUTCOMES = Object.keys(OUTCOME_VIEW) as HistoryOutcome[];

const el = {
  autoCheckin: byId("auto-checkin", HTMLInputElement),
  checkinTime: byId("checkin-time", HTMLInputElement),
  checkinLast: byId("checkin-last", HTMLElement),
  checkinNext: byId("checkin-next", HTMLElement),
  redeemMode: byId("redeem-mode", HTMLSelectElement),
  redeemInterval: byId("redeem-interval", HTMLSelectElement),
  redeemLast: byId("redeem-last", HTMLElement),
  redeemNext: byId("redeem-next", HTMLElement),
  autoResult: byId("auto-result", HTMLParagraphElement),
  notifyList: byId("notify-list", HTMLDivElement),
  notifyResult: byId("notify-result", HTMLParagraphElement),
  roleSelectRow: byId("role-select-row", HTMLDivElement),
  roleSelect: byId("role-select", HTMLSelectElement),
  roleEmpty: byId("role-empty", HTMLParagraphElement),
  roleResult: byId("role-result", HTMLParagraphElement),
  sessions: byId("sessions", HTMLDivElement),
  codesCaption: byId("codes-caption", HTMLParagraphElement),
  codesBody: byId("codes-body", HTMLTableSectionElement),
  clearHistory: byId("clear-history", HTMLButtonElement),
  filterTask: byId("filter-task", HTMLSelectElement),
  filterOutcome: byId("filter-outcome", HTMLSelectElement),
  historyResult: byId("history-result", HTMLParagraphElement),
  historyBody: byId("history-body", HTMLTableSectionElement),
};

const notifyInputs = Object.fromEntries(
  NOTIFICATION_KEYS.map((key) => [
    key,
    h("input", { type: "checkbox", id: `notify-${key}` }),
  ]),
) as Record<keyof NotificationSettings, HTMLInputElement>;

let latest: LoadedState | null = null;

function render(loaded: LoadedState): void {
  latest = loaded;
  const { state, alarms } = loaded;
  const { settings, account, checkin, redeem } = state;

  el.autoCheckin.checked = settings.autoCheckin;
  el.checkinTime.value = settings.checkinTime;
  el.checkinLast.textContent = formatLastRun(checkin.lastRunAt);
  el.checkinNext.textContent = formatNextRun(
    settings.autoCheckin,
    alarms.checkin,
    "自動受取オフ",
  );
  el.redeemMode.value = settings.redeemMode;
  el.redeemInterval.value = String(settings.redeemIntervalHours);
  el.redeemLast.textContent = formatLastRun(redeem.lastRunAt);
  el.redeemNext.textContent = formatNextRun(
    settings.redeemMode !== "off",
    alarms.redeem,
    "定期確認オフ",
  );

  for (const key of NOTIFICATION_KEYS)
    notifyInputs[key].checked = settings.notifications[key];

  const role = selectRole(account.roles, settings.selectedUid);
  el.roleSelectRow.hidden = role === null;
  el.roleEmpty.hidden = role !== null;
  fillRoleSelect(el.roleSelect, account.roles, role);
  el.sessions.replaceChildren(...sessionRows(state.session));

  const records = codeRecordsFor(redeem, role?.uid ?? null);
  el.codesCaption.textContent =
    role === null
      ? "キャラクターが未選択です。"
      : `${role.nickname}（UID ${role.uid}）の記録`;
  el.codesBody.replaceChildren(
    ...(records.length === 0
      ? [emptyRow(4, "記録はまだありません")]
      : records.map(codeRow)),
  );

  renderHistory(state.history);
}

function renderHistory(history: readonly HistoryEntry[]): void {
  const entries = filterHistory(history, currentFilter());
  el.historyBody.replaceChildren(
    ...(entries.length === 0
      ? [emptyRow(5, "該当する履歴はありません")]
      : entries.map(historyRow)),
  );
}

function emptyRow(columns: number, text: string): HTMLTableRowElement {
  return h(
    "tr",
    {},
    h("td", { colspan: String(columns), class: "empty" }, text),
  );
}

function codeRow(record: CodeRecord): HTMLTableRowElement {
  return h(
    "tr",
    {},
    h("td", {}, h("code", { class: "code" }, record.code)),
    h("td", {}, chip(CODE_STATUS_VIEW[record.status])),
    h("td", { class: "nowrap" }, formatDateTime(record.updatedAt)),
    h("td", {}, record.message),
  );
}

function historyRow(entry: HistoryEntry): HTMLTableRowElement {
  return h(
    "tr",
    {},
    h("td", { class: "nowrap" }, formatDateTime(entry.at)),
    h("td", { class: "nowrap" }, TASK_LABEL[entry.task]),
    h("td", { class: "nowrap" }, TRIGGER_LABEL[entry.trigger]),
    h("td", {}, chip(OUTCOME_VIEW[entry.outcome])),
    h(
      "td",
      {},
      entry.message,
      entry.code !== null && h("code", { class: "code" }, entry.code),
    ),
  );
}

function pick<T extends string>(
  value: string,
  allowed: readonly T[],
): T | "all" {
  return allowed.find((item) => item === value) ?? "all";
}

function currentFilter(): HistoryFilter {
  return {
    task: pick(el.filterTask.value, TASKS),
    outcome: pick(el.filterOutcome.value, OUTCOMES),
  };
}

async function refresh(): Promise<void> {
  render(await loadState());
}

function buildStaticControls(): void {
  fillRedeemModeSelect(el.redeemMode);
  el.redeemInterval.replaceChildren(
    ...REDEEM_INTERVAL_HOURS.map((hours) =>
      h("option", { value: String(hours) }, `${String(hours)}時間ごと`),
    ),
  );
  el.notifyList.replaceChildren(
    ...NOTIFICATION_KEYS.map((key) =>
      h(
        "label",
        { class: "check", for: `notify-${key}` },
        notifyInputs[key],
        NOTIFICATION_LABEL[key],
      ),
    ),
  );
  el.filterTask.replaceChildren(
    h("option", { value: "all" }, "すべて"),
    ...TASKS.map((task) => h("option", { value: task }, TASK_LABEL[task])),
  );
  el.filterOutcome.replaceChildren(
    h("option", { value: "all" }, "すべて"),
    ...OUTCOMES.map((outcome) =>
      h("option", { value: outcome }, OUTCOME_VIEW[outcome].label),
    ),
  );
}

function wire(): void {
  el.autoCheckin.addEventListener("change", () => {
    void updateSettings(
      { autoCheckin: el.autoCheckin.checked },
      el.autoResult,
      refresh,
    );
  });
  el.checkinTime.addEventListener("change", () => {
    const value = el.checkinTime.value;
    if (!isTimeOfDay(value)) {
      showError(el.autoResult, "時刻を HH:MM 形式で入力してください");
      void refresh();
      return;
    }
    void updateSettings({ checkinTime: value }, el.autoResult, refresh);
  });
  el.redeemMode.addEventListener("change", () => {
    const redeemMode = redeemModeOf(el.redeemMode);
    if (redeemMode === null) return;
    void updateSettings({ redeemMode }, el.autoResult, refresh);
  });
  el.redeemInterval.addEventListener("change", () => {
    const hours = REDEEM_INTERVAL_HOURS.find(
      (h) => String(h) === el.redeemInterval.value,
    );
    if (hours === undefined) return;
    void updateSettings({ redeemIntervalHours: hours }, el.autoResult, refresh);
  });
  for (const key of NOTIFICATION_KEYS) {
    notifyInputs[key].addEventListener("change", () => {
      void updateSettings(
        { notifications: { [key]: notifyInputs[key].checked } },
        el.notifyResult,
        refresh,
      );
    });
  }
  el.roleSelect.addEventListener("change", () => {
    void updateSettings(
      { selectedUid: selectedUidOf(el.roleSelect) },
      el.roleResult,
      refresh,
    );
  });
  const rerenderHistory = (): void => {
    if (latest) renderHistory(latest.state.history);
  };
  el.filterTask.addEventListener("change", rerenderHistory);
  el.filterOutcome.addEventListener("change", rerenderHistory);
  el.clearHistory.addEventListener("click", () => {
    if (!confirm("実行履歴をすべて消去しますか？この操作は元に戻せません。"))
      return;
    void runFromButton(
      el.clearHistory,
      el.historyResult,
      { type: "clearHistory" },
      "消去中…",
    );
  });
  onStateChanged(() => {
    void refresh();
  });
}

buildStaticControls();
wire();
void refresh();

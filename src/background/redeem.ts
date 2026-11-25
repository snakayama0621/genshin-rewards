import { describeRedeemOutcome, describeRedeemRun } from "../shared/labels";
import { isRedeemCode } from "../shared/schema";
import { gameDayOf } from "../shared/time";
import {
  TERMINAL_CODE_STATUSES,
  type CodeRecord,
  type GameRole,
  type HistoryOutcome,
  type RedeemCode,
  type RedeemOutcome,
  type RedeemRunResult,
  type TerminalCodeStatus,
  type Trigger,
} from "../shared/types";
import { fetchCodes } from "./api/codes";
import { redeemCode } from "./api/hoyo";
import { resolveRole, selectRole } from "./account";
import type { Deps } from "./deps";
import { appendHistory } from "./history";
import { notify, type NoticeRequest } from "./notify";
import { observeSession } from "./session";
import { singleFlight } from "./single-flight";

export const MAX_REDEEMS_PER_RUN = 10;
export const MAX_CODE_ATTEMPTS = 3;
export const CODE_RECORD_LIMIT = 500;
export const NOTICE_CODE_LIMIT = 5;

type Terminal = Extract<RedeemOutcome, { kind: TerminalCodeStatus }>;
export type ManualRedeemResult =
  RedeemOutcome | { readonly kind: "invalid_format" };

export function recordKey(uid: string, code: string): string {
  return `${uid}:${code}`;
}

export function isTerminal(outcome: { readonly kind: string }): outcome is Terminal {
  return (TERMINAL_CODE_STATUSES as readonly string[]).includes(outcome.kind);
}

/** 記録が500件を超えたら updatedAt の古い順に削る。 */
export function pruneRecords(
  codes: Readonly<Record<string, CodeRecord>>,
): Record<string, CodeRecord> {
  const entries = Object.entries(codes);
  if (entries.length <= CODE_RECORD_LIMIT) return { ...codes };
  const newest = entries
    .toSorted(([, a], [, b]) => b.updatedAt - a.updatedAt)
    .slice(0, CODE_RECORD_LIMIT);
  return Object.fromEntries(newest);
}

function isPending(record: CodeRecord | undefined): boolean {
  return (
    record === undefined ||
    (record.status === "failed" && record.attempts < MAX_CODE_ATTEMPTS)
  );
}

function historyOutcomeOf(outcome: RedeemOutcome): HistoryOutcome {
  if (outcome.kind === "redeemed") return "success";
  return isTerminal(outcome) || outcome.kind === "cooldown"
    ? "skipped"
    : "failure";
}

/** 確定状態と error だけ記録する。cooldown などは次回そのまま再試行する。 */
async function saveOutcome(
  deps: Deps,
  role: GameRole,
  code: RedeemCode,
  outcome: RedeemOutcome,
): Promise<void> {
  const status = isTerminal(outcome)
    ? outcome.kind
    : outcome.kind === "error"
      ? "failed"
      : null;
  if (status === null) return;
  const key = recordKey(role.uid, code);
  await deps.store.update("redeem", (prev) => {
    const record: CodeRecord = {
      code,
      uid: role.uid,
      status,
      attempts: (prev.codes[key]?.attempts ?? 0) + 1,
      updatedAt: deps.now(),
      message: describeRedeemOutcome(outcome),
    };
    return { ...prev, codes: pruneRecords({ ...prev.codes, [key]: record }) };
  });
}

async function redeemOne(
  deps: Deps,
  trigger: Trigger,
  role: GameRole,
  code: RedeemCode,
): Promise<RedeemOutcome> {
  const outcome = await redeemCode(deps, role, code);
  await observeSession(deps, "hoyoverse", outcome.kind);
  if (outcome.kind === "captcha") {
    await deps.store.update("redeem", (prev) => ({
      ...prev,
      captchaDay: gameDayOf(deps.now()),
    }));
  }
  await saveOutcome(deps, role, code, outcome);
  await appendHistory(deps, {
    task: "redeem",
    trigger,
    outcome: historyOutcomeOf(outcome),
    message: `${code}: ${describeRedeemOutcome(outcome)}`,
    code,
  });
  return outcome;
}

function failureNotice(kind: string, message: string): NoticeRequest | null {
  const base = {
    setting: "failure",
    title: "交換コードの引き換えに失敗",
    message,
  } as const;
  switch (kind) {
    case "captcha":
      return { ...base, target: "gift-page" };
    case "error":
    case "rate_limited":
    case "no_role":
    case "source_error":
      return { ...base, target: "options" };
    default: // cooldown は次回再試行、not_logged_in は session の通知に任せる
      return null;
  }
}

async function redeemSequentially(
  deps: Deps,
  trigger: Trigger,
  role: GameRole,
  codes: readonly RedeemCode[],
): Promise<
  { redeemed: number; skipped: number } | Exclude<RedeemOutcome, Terminal>
> {
  let redeemed = 0;
  let skipped = 0;
  // 送信間隔（6秒）は HTTP 層が交換APIのホスト単位で守る
  for (const code of codes) {
    const outcome = await redeemOne(deps, trigger, role, code);
    if (!isTerminal(outcome)) return outcome;
    if (outcome.kind === "redeemed") redeemed += 1;
    else skipped += 1;
  }
  return { redeemed, skipped };
}

async function redeemPending(
  deps: Deps,
  trigger: Trigger,
): Promise<RedeemRunResult> {
  const resolved = await resolveRole(deps);
  if (resolved.kind !== "role") return logged(deps, trigger, resolved);
  const { role } = resolved;
  const source = await fetchCodes(deps);
  if (source.kind === "error") {
    return logged(deps, trigger, {
      kind: "source_error",
      message: source.message,
    });
  }
  const state = await deps.store.update("redeem", (prev) => ({
    ...prev,
    available: source.codes,
    availableFetchedAt: deps.now(),
  }));
  const recordOf = (code: RedeemCode) => state.codes[recordKey(role.uid, code)];
  const pending = source.codes.filter((code) => isPending(recordOf(code)));
  // 試行上限に達して諦めたコードの数を「失敗」として返す
  const givenUp = source.codes.filter((code) => {
    const record = recordOf(code);
    return record?.status === "failed" && record.attempts >= MAX_CODE_ATTEMPTS;
  }).length;
  const run = await redeemSequentially(
    deps,
    trigger,
    role,
    pending.slice(0, MAX_REDEEMS_PER_RUN),
  );
  return "kind" in run ? run : { kind: "done", ...run, failed: givenUp };
}

/** コードを試す前に終わった実行だけ、ここで履歴に残す（試したコードは1件ずつ記録済み）。 */
async function logged(
  deps: Deps,
  trigger: Trigger,
  result: RedeemRunResult,
): Promise<RedeemRunResult> {
  await appendHistory(deps, {
    task: "redeem",
    trigger,
    outcome: "failure",
    message: describeRedeemRun(result),
  });
  return result;
}

/** 実行結果を保存して通知する（一括引き換えと、コード一覧の確認の失敗で共通）。 */
async function settle(deps: Deps, result: RedeemRunResult): Promise<RedeemRunResult> {
  await deps.store.update("redeem", (prev) => ({
    ...prev,
    lastRunAt: deps.now(),
    lastResult: result,
  }));
  const notice = runNotice(result);
  if (notice) await notify(deps, notice);
  return result;
}

async function runAll(deps: Deps, trigger: Trigger): Promise<RedeemRunResult> {
  return settle(deps, await redeemPending(deps, trigger));
}

function runNotice(result: RedeemRunResult): NoticeRequest | null {
  if (result.kind !== "done") return failureNotice(result.kind, describeRedeemRun(result));
  if (result.redeemed === 0) return null;
  return {
    setting: "redeemSuccess",
    target: "none",
    title: "交換コード",
    message: `${String(result.redeemed)} 件の交換コードを引き換えました`,
  };
}

/** 取得元の未処理コードを最大10件、6秒間隔で引き換える（DESIGN §4.2）。 */
export const runRedeemAll = singleFlight(runAll);

function freshCodesNotice(codes: readonly RedeemCode[]): NoticeRequest {
  const rest = codes.length - NOTICE_CODE_LIMIT;
  const shown = codes.slice(0, NOTICE_CODE_LIMIT).join("、");
  return {
    setting: null,
    target: "gift-page",
    title: "新しい交換コード",
    message: rest > 0 ? `${shown} ほか ${String(rest)} 件` : shown,
  };
}

/**
 * 公開のコード一覧だけを取得し、前回の一覧になく、対象UIDで確定済みでもないコードを通知する。
 * HoYoLAB / HoYoverse へは通信しない（対象キャラクターは保存済みの一覧から選ぶ）。
 * 成功は履歴に残さない（1時間ごとの確認で履歴の上限を埋めないため）。
 */
async function checkCodes(deps: Deps, trigger: Trigger): Promise<RedeemRunResult> {
  const source = await fetchCodes(deps);
  if (source.kind === "error") {
    return settle(
      deps,
      await logged(deps, trigger, { kind: "source_error", message: source.message }),
    );
  }
  const account = await deps.store.get("account");
  const settings = await deps.store.get("settings");
  const uid = selectRole(account.roles, settings.selectedUid)?.uid ?? null;
  const now = deps.now();
  let fresh: readonly RedeemCode[] = [];
  await deps.store.update("redeem", (prev) => {
    const settled = (code: RedeemCode) => {
      const record = uid === null ? undefined : prev.codes[recordKey(uid, code)];
      return record !== undefined && isTerminal({ kind: record.status });
    };
    fresh = source.codes.filter((code) => !prev.available.includes(code) && !settled(code));
    return {
      ...prev,
      available: source.codes,
      availableFetchedAt: now,
      lastRunAt: now,
      lastResult: { kind: "checked", fresh: fresh.length },
    };
  });
  if (fresh.length > 0) await notify(deps, freshCodesNotice(fresh));
  return { kind: "checked", fresh: fresh.length };
}

/** 通知モードの定期確認。引き換えはしない（DESIGN §4.2）。 */
export const runCodeCheck = singleFlight(checkCodes);

/** 手動入力の1件だけを引き換える。形式違い・引き換え済みなら通信しない。 */
export async function redeemManually(
  deps: Deps,
  input: string,
): Promise<ManualRedeemResult> {
  const code = input.trim();
  if (!isRedeemCode(code)) return { kind: "invalid_format" };
  const resolved = await resolveRole(deps);
  if (resolved.kind !== "role") return resolved;
  const { codes } = await deps.store.get("redeem");
  const record = codes[recordKey(resolved.role.uid, code)];
  if (record?.status === "redeemed" || record?.status === "already_redeemed") {
    return { kind: record.status };
  }
  const outcome = await redeemOne(deps, "manual", resolved.role, code);
  const message = `${code}: ${describeRedeemOutcome(outcome)}`;
  const notice =
    outcome.kind === "redeemed"
      ? ({
          setting: "redeemSuccess",
          target: "none",
          title: "交換コード",
          message,
        } as const)
      : failureNotice(outcome.kind, message);
  if (notice) await notify(deps, notice);
  return outcome;
}

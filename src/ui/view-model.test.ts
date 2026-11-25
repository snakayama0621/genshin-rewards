import { describe, expect, it } from "vitest";
import { isGameDay, isRedeemCode, isUid } from "../shared/schema";
import type {
  CheckinState,
  CodeRecord,
  CodeStatus,
  GameDay,
  GameRole,
  HistoryEntry,
  RedeemCode,
  RedeemState,
  Uid,
} from "../shared/types";
import {
  ACCOUNT_STALE_MS,
  checkinView,
  codeRecordsFor,
  filterHistory,
  recentHistory,
  redeemSummaryView,
  selectRole,
  shouldRefreshAccount,
} from "./view-model";

function uid(value: string): Uid {
  if (!isUid(value)) throw new Error(value);
  return value;
}
function code(value: string): RedeemCode {
  if (!isRedeemCode(value)) throw new Error(value);
  return value;
}
function day(value: string): GameDay {
  if (!isGameDay(value)) throw new Error(value);
  return value;
}

const MAIN = uid("812345678");
const ALT = uid("812345679");

function role(id: Uid, level: number): GameRole {
  return {
    uid: id,
    nickname: `旅人${id}`,
    level,
    server: "os_asia",
    serverName: "Asia",
  };
}

function record(
  owner: Uid,
  value: string,
  status: CodeStatus,
  updatedAt = 0,
): CodeRecord {
  return {
    code: code(value),
    uid: owner,
    status,
    attempts: 1,
    updatedAt,
    message: "",
  };
}

function redeemState(
  available: readonly string[],
  records: readonly CodeRecord[],
  availableFetchedAt: number | null = 1,
): RedeemState {
  return {
    available: available.map(code),
    availableFetchedAt,
    codes: Object.fromEntries(records.map((r) => [`${r.uid}:${r.code}`, r])),
    lastRunAt: null,
    lastResult: null,
    captchaDay: null,
  };
}

describe("selectRole", () => {
  it("設定の UID に一致するキャラクターを選ぶ（レベルが低くても）", () => {
    expect(selectRole([role(MAIN, 60), role(ALT, 20)], ALT)?.uid).toBe(ALT);
  });

  it("設定の UID がいなければ最もレベルが高いキャラクター", () => {
    expect(
      selectRole([role(ALT, 20), role(MAIN, 60)], uid("899999999"))?.uid,
    ).toBe(MAIN);
  });

  it("未設定なら最もレベルが高いキャラクター", () => {
    expect(selectRole([role(ALT, 20), role(MAIN, 60)], null)?.uid).toBe(MAIN);
  });

  it("キャラクターがいなければ null", () => {
    expect(selectRole([], MAIN)).toBeNull();
  });
});

describe("shouldRefreshAccount（ポップアップを開いたときの再取得判定）", () => {
  const now = 1_000_000_000;
  const roles = [role(MAIN, 60)];

  it("一度も取得していなければ再取得する", () => {
    expect(shouldRefreshAccount({ roles, fetchedAt: null }, now)).toBe(true);
  });

  it("10分未満なら再取得しない", () => {
    expect(
      shouldRefreshAccount(
        { roles, fetchedAt: now - ACCOUNT_STALE_MS + 1 },
        now,
      ),
    ).toBe(false);
  });

  it("ちょうど10分経過したら再取得する", () => {
    expect(
      shouldRefreshAccount({ roles, fetchedAt: now - ACCOUNT_STALE_MS }, now),
    ).toBe(true);
  });

  it("キャラクターが空ならログイン直後を想定して取得から間もなくても再取得する", () => {
    expect(shouldRefreshAccount({ roles: [], fetchedAt: now }, now)).toBe(true);
  });
});

describe("checkinView", () => {
  const today = day("2026-11-24");
  const base: CheckinState = {
    gameDay: today,
    result: null,
    autoAttempts: 0,
    lastRunAt: null,
  };

  it("当日の受取済みは「受取済み」と今月の日数", () => {
    const view = checkinView(
      { ...base, result: { kind: "claimed", totalSignDay: 5 } },
      today,
    );
    expect(view.display).toBe("claimed");
    expect(view.status.label).toBe("受取済み");
    expect(view.detail).toBe("ログインボーナスを受け取りました（今月 5 日目）");
  });

  it("前日の結果は今日の結果として扱わず「未受取」", () => {
    const view = checkinView(
      {
        ...base,
        gameDay: day("2026-11-23"),
        result: { kind: "claimed", totalSignDay: 4 },
      },
      today,
    );
    expect(view.display).toBe("pending");
    expect(view.detail).toBe("本日はまだ受け取っていません");
  });

  it("CAPTCHA は「要認証」", () => {
    const view = checkinView({ ...base, result: { kind: "captcha" } }, today);
    expect(view.display).toBe("captcha");
    expect(view.status).toEqual({ label: "要認証", tone: "warning" });
  });
});

describe("redeemSummaryView", () => {
  it("有効コードのうち選択中 UID で引き換え済み・使用済みのものを数える", () => {
    const state = redeemState(
      ["AAA", "BBB", "CCC", "DDD"],
      [
        record(MAIN, "AAA", "redeemed"),
        record(MAIN, "BBB", "already_redeemed"),
        record(MAIN, "CCC", "failed"),
        record(ALT, "DDD", "redeemed"),
        record(MAIN, "OLD", "redeemed"),
      ],
    );
    expect(redeemSummaryView(state, MAIN)).toEqual({
      label: "有効コード 4 件中 2 件 引き換え済み",
      tone: "neutral",
    });
  });

  it("すべて引き換え済みなら success", () => {
    const state = redeemState(["AAA"], [record(MAIN, "AAA", "redeemed")]);
    expect(redeemSummaryView(state, MAIN)).toEqual({
      label: "有効コード 1 件中 1 件 引き換え済み",
      tone: "success",
    });
  });

  it("キャラクター未選択なら引き換え済みは 0 件", () => {
    const state = redeemState(["AAA"], [record(MAIN, "AAA", "redeemed")]);
    expect(redeemSummaryView(state, null).label).toBe(
      "有効コード 1 件中 0 件 引き換え済み",
    );
  });

  it("有効コードが 0 件なら success にしない", () => {
    expect(redeemSummaryView(redeemState([], []), MAIN).tone).toBe("neutral");
  });

  it("取得元を一度も確認していなければ「未確認」", () => {
    expect(redeemSummaryView(redeemState([], [], null), MAIN).label).toBe(
      "有効コード 未確認",
    );
  });
});

describe("codeRecordsFor", () => {
  it("選択中 UID の記録だけを更新日時の新しい順に返す", () => {
    const state = redeemState(
      [],
      [
        record(MAIN, "OLD", "expired", 1),
        record(ALT, "OTHER", "redeemed", 5),
        record(MAIN, "NEW", "redeemed", 3),
      ],
    );
    expect(codeRecordsFor(state, MAIN).map((r) => r.code)).toEqual([
      "NEW",
      "OLD",
    ]);
  });

  it("UID がなければ空", () => {
    const state = redeemState([], [record(MAIN, "AAA", "redeemed")]);
    expect(codeRecordsFor(state, null)).toEqual([]);
  });
});

describe("履歴の絞り込みと並び順", () => {
  function entry(
    id: string,
    at: number,
    task: HistoryEntry["task"],
    outcome: HistoryEntry["outcome"],
  ): HistoryEntry {
    return { id, at, task, outcome, trigger: "auto", message: "", code: null };
  }
  const history = [
    entry("a", 1, "checkin", "success"),
    entry("b", 4, "redeem", "failure"),
    entry("c", 3, "checkin", "failure"),
    entry("d", 2, "redeem", "success"),
    entry("e", 6, "account", "success"),
    entry("f", 5, "checkin", "skipped"),
  ];
  const ids = (entries: readonly HistoryEntry[]): string[] =>
    entries.map((e) => e.id);

  it("条件なしなら全件を新しい順", () => {
    expect(
      ids(filterHistory(history, { task: "all", outcome: "all" })),
    ).toEqual(["e", "f", "b", "c", "d", "a"]);
  });

  it("処理と結果の両方で絞り込める", () => {
    expect(
      ids(filterHistory(history, { task: "checkin", outcome: "failure" })),
    ).toEqual(["c"]);
    expect(
      ids(filterHistory(history, { task: "redeem", outcome: "all" })),
    ).toEqual(["b", "d"]);
    expect(
      ids(filterHistory(history, { task: "all", outcome: "success" })),
    ).toEqual(["e", "d", "a"]);
  });

  it("元の配列を並べ替えない", () => {
    filterHistory(history, { task: "all", outcome: "all" });
    expect(ids(history)).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  it("ポップアップは新しい順に 5 件", () => {
    expect(ids(recentHistory(history))).toEqual(["e", "f", "b", "c", "d"]);
  });
});

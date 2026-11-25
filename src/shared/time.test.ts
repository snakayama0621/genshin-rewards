import { afterEach, describe, expect, it, vi } from "vitest";
import { isGameDay, isTimeOfDay } from "./schema";
import { checkinDueAt, gameDayOf, gameDayStart, nextGameDay } from "./time";
import type { GameDay, TimeOfDay } from "./types";

function day(value: string): GameDay {
  if (!isGameDay(value)) throw new Error(value);
  return value;
}

function time(value: string): TimeOfDay {
  if (!isTimeOfDay(value)) throw new Error(value);
  return value;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("gameDayOf (HoYoLAB の日付は UTC+8 の 0 時で切り替わる)", () => {
  it("UTC+8 で 23:59:59 の時点はまだ前日", () => {
    expect(gameDayOf(Date.parse("2026-11-24T15:59:59Z"))).toBe("2026-11-24");
  });

  it("UTC+8 で 0:00 ちょうど（日本時間 1:00）に翌日へ切り替わる", () => {
    expect(gameDayOf(Date.parse("2026-11-24T16:00:00Z"))).toBe("2026-11-25");
  });

  it("月末と年末をまたいでも正しく繰り上がる", () => {
    expect(gameDayOf(Date.parse("2026-12-31T16:00:00Z"))).toBe("2027-01-01");
  });

  it("gameDayStart は UTC+8 の 0 時を返し、gameDayOf と往復できる", () => {
    const start = gameDayStart(day("2026-11-25"));
    expect(new Date(start).toISOString()).toBe("2026-11-24T16:00:00.000Z");
    expect(gameDayOf(start)).toBe("2026-11-25");
    expect(gameDayOf(start - 1)).toBe("2026-11-24");
  });

  it("nextGameDay は翌日を返す", () => {
    expect(nextGameDay(day("2026-02-28"))).toBe("2026-03-01");
  });
});

describe("checkinDueAt (指定したローカル時刻がゲーム内日付の中で最初に来る瞬間)", () => {
  it("日本時間 01:05 は切り替え直後の 5 分後", () => {
    vi.stubEnv("TZ", "Asia/Tokyo");
    const due = checkinDueAt(day("2026-11-25"), time("01:05"));
    expect(new Date(due).toISOString()).toBe("2026-11-24T16:05:00.000Z");
  });

  it("日本時間 00:30 は切り替え前なので、ローカル日付では翌日の 00:30 になる", () => {
    vi.stubEnv("TZ", "Asia/Tokyo");
    const due = checkinDueAt(day("2026-11-25"), time("00:30"));
    expect(new Date(due).toISOString()).toBe("2026-11-25T15:30:00.000Z");
    expect(gameDayOf(due)).toBe("2026-11-25");
  });

  it("日本時間 01:00 ちょうどは切り替えの瞬間そのもの", () => {
    vi.stubEnv("TZ", "Asia/Tokyo");
    const due = checkinDueAt(day("2026-11-25"), time("01:00"));
    expect(due).toBe(gameDayStart(day("2026-11-25")));
  });

  it("ロサンゼルス (UTC-8) の 09:00 も同じゲーム内日付の窓に入る", () => {
    vi.stubEnv("TZ", "America/Los_Angeles");
    const target = day("2026-11-25");
    const due = checkinDueAt(target, time("09:00"));
    expect(new Date(due).toISOString()).toBe("2026-11-24T17:00:00.000Z");
    expect(gameDayOf(due)).toBe(target);
  });

  it("どのタイムゾーン・時刻でも結果はそのゲーム内日付の範囲に収まる", () => {
    for (const tz of [
      "Asia/Tokyo",
      "America/New_York",
      "Europe/London",
      "Australia/Lord_Howe",
    ]) {
      vi.stubEnv("TZ", tz);
      for (const hhmm of ["00:00", "00:59", "01:00", "12:34", "23:59"]) {
        const target = day("2026-03-08");
        expect(gameDayOf(checkinDueAt(target, time(hhmm)))).toBe(target);
      }
    }
  });
});

import { describe, expect, it } from "vitest";
import {
  formatDateTime,
  formatLastRun,
  formatNextRun,
  formatShortDateTime,
} from "./format";

// Local-time construction keeps these assertions independent of the runner's TZ.
const AT = new Date(2026, 10, 4, 9, 5).getTime();

describe("日時の表示（利用者のローカル時刻、ja-JP）", () => {
  it("短い形式は 月/日 時:分", () => {
    expect(formatShortDateTime(AT)).toBe("11/4 09:05");
  });

  it("完全な形式は 年/月/日 時:分（ゼロ埋め）", () => {
    expect(formatDateTime(AT)).toBe("2026/11/04 09:05");
  });
});

describe("formatLastRun", () => {
  it("一度も実行していなければ「未実行」", () => {
    expect(formatLastRun(null)).toBe("未実行");
  });

  it("実行済みなら短い日時", () => {
    expect(formatLastRun(AT)).toBe("11/4 09:05");
  });
});

describe("formatNextRun", () => {
  it("自動実行がオフならアラームがあってもオフ表示", () => {
    expect(formatNextRun(false, AT, "自動受取オフ")).toBe("自動受取オフ");
  });

  it("オンでアラーム未登録なら「未設定」", () => {
    expect(formatNextRun(true, undefined, "自動受取オフ")).toBe("未設定");
  });

  it("オンならアラームの予定時刻", () => {
    expect(formatNextRun(true, AT, "自動受取オフ")).toBe("11/4 09:05");
  });
});

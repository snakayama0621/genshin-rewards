import { describe, expect, it } from "vitest";
import type { HistoryEntry } from "../shared/types";
import { createTestEnv } from "../testing/fakes";
import { NOON_JST } from "../testing/hoyo-replies";
import { appendHistory, pruneHistory } from "./history";

const DAY = 86_400_000;

function entry(i: number, at: number): HistoryEntry {
  return { id: `e${String(i)}`, at, task: "checkin", trigger: "auto", outcome: "success", message: "", code: null };
}

describe("history", () => {
  it("最大300件を残し、古いものから削る", () => {
    const entries = Array.from({ length: 301 }, (_, i) => entry(i, NOON_JST - 301 + i));
    const pruned = pruneHistory(entries, NOON_JST);
    expect(pruned).toHaveLength(300);
    expect(pruned[0]?.id).toBe("e1");
    expect(pruned.at(-1)?.id).toBe("e300");
  });

  it("30日より古いものを削る（ちょうど30日前は残す）", () => {
    const pruned = pruneHistory([entry(0, NOON_JST - 30 * DAY - 1), entry(1, NOON_JST - 30 * DAY), entry(2, NOON_JST)], NOON_JST);
    expect(pruned.map((e) => e.id)).toEqual(["e1", "e2"]);
  });

  it("追記で ID と日時を付け、上限を超えた分と期限切れを削る", async () => {
    const env = createTestEnv(NOON_JST);
    env.seed("history", [entry(0, NOON_JST - 31 * DAY), ...Array.from({ length: 300 }, (_, i) => entry(i + 1, NOON_JST - 1000 + i))]);

    await appendHistory(env.deps, { task: "redeem", trigger: "manual", outcome: "failure", message: "m" });

    const history = await env.read("history");
    expect(history).toHaveLength(300);
    expect(history[0]?.id).toBe("e2");
    expect(history.at(-1)).toEqual({
      id: "id1",
      at: NOON_JST,
      task: "redeem",
      trigger: "manual",
      outcome: "failure",
      message: "m",
      code: null,
    });
  });
});

const SHORT = new Intl.DateTimeFormat("ja-JP", {
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

const FULL = new Intl.DateTimeFormat("ja-JP", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

/** "11/4 09:05" in the viewer's local time zone. */
export function formatShortDateTime(at: number): string {
  return SHORT.format(at);
}

/** "2026/11/04 09:05" in the viewer's local time zone. */
export function formatDateTime(at: number): string {
  return FULL.format(at);
}

export function formatLastRun(at: number | null): string {
  return at === null ? "未実行" : formatShortDateTime(at);
}

/** Next-run text for an auto task, from the alarm's scheduledTime. */
export function formatNextRun(
  enabled: boolean,
  scheduledTime: number | undefined,
  offLabel: string,
): string {
  if (!enabled) return offLabel;
  if (scheduledTime === undefined) return "未設定";
  return formatShortDateTime(scheduledTime);
}

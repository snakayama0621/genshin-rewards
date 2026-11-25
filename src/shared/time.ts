import { isGameDay } from "./schema";
import type { GameDay, TimeOfDay } from "./types";

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;
const GAME_DAY_UTC_OFFSET_MS = 8 * HOUR_MS;

export function gameDayOf(at: number): GameDay {
  const day = new Date(at + GAME_DAY_UTC_OFFSET_MS).toISOString().slice(0, 10);
  if (!isGameDay(day)) throw new Error(`invalid timestamp: ${String(at)}`);
  return day;
}

export function gameDayStart(day: GameDay): number {
  return Date.parse(`${day}T00:00:00Z`) - GAME_DAY_UTC_OFFSET_MS;
}

export function nextGameDay(day: GameDay): GameDay {
  return gameDayOf(gameDayStart(day) + DAY_MS);
}

/** The one instant inside the game day whose local wall-clock time is `time`. */
export function checkinDueAt(day: GameDay, time: TimeOfDay): number {
  const start = gameDayStart(day);
  const [hours, minutes] = time.split(":").map(Number);
  const startLocal = new Date(start);
  const atLocalTime = (dayOffset: number): number =>
    new Date(
      startLocal.getFullYear(),
      startLocal.getMonth(),
      startLocal.getDate() + dayOffset,
      hours,
      minutes,
    ).getTime();
  const sameLocalDate = atLocalTime(0);
  const candidate = sameLocalDate >= start ? sameLocalDate : atLocalTime(1);
  // ponytail: a wall time skipped by a DST jump can land past the window; clamp to its last minute.
  return Math.min(candidate, start + DAY_MS - 60_000);
}

import type { StorageKey, StorageSchema } from "../shared/types";

export const ALARM_NAMES = ["checkin", "checkin-retry", "redeem"] as const;
export type AlarmName = (typeof ALARM_NAMES)[number];

export function isAlarmName(value: string): value is AlarmName {
  return (ALARM_NAMES as readonly string[]).includes(value);
}

export interface AlarmSpec {
  readonly when: number;
  readonly periodInMinutes?: number;
}

export interface AlarmInfo {
  readonly scheduledTime: number;
  readonly periodInMinutes?: number;
}

export interface AlarmPort {
  create(name: AlarmName, spec: AlarmSpec): Promise<void>;
  clear(name: AlarmName): Promise<void>;
  get(name: AlarmName): Promise<AlarmInfo | undefined>;
}

export interface Notice {
  readonly id: string;
  readonly title: string;
  readonly message: string;
}

export interface NotifierPort {
  show(notice: Notice): Promise<void>;
}

export interface Store {
  /** 保存値を検証して返す。未保存・不正な値なら既定値。 */
  get<K extends StorageKey>(key: K): Promise<StorageSchema[K]>;
  /** 読み取り・変更・書き込みを1本のPromiseチェーンで直列化する。 */
  update<K extends StorageKey>(
    key: K,
    fn: (prev: StorageSchema[K]) => StorageSchema[K],
  ): Promise<StorageSchema[K]>;
}

export interface Deps {
  readonly fetch: typeof fetch;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly store: Store;
  readonly alarms: AlarmPort;
  readonly notifier: NotifierPort;
  readonly randomId: () => string;
}

import { parseStored } from "../shared/schema";
import type { StorageKey, StorageSchema } from "../shared/types";
import type { Store } from "./deps";

export interface StorageBackend {
  read(key: StorageKey): Promise<unknown>;
  write<K extends StorageKey>(key: K, value: StorageSchema[K]): Promise<void>;
}

export function createStore(backend: StorageBackend): Store {
  let chain: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(op: () => Promise<T>): Promise<T> => {
    const run = chain.then(op);
    // 1件の失敗で後続の書き込みが止まらないよう、チェーンには結果を残さない
    chain = run.catch(() => undefined);
    return run;
  };
  const read = async <K extends StorageKey>(key: K) =>
    parseStored(key, await backend.read(key));

  return {
    get: (key) => enqueue(() => read(key)),
    update: (key, fn) =>
      enqueue(async () => {
        const next = fn(await read(key));
        await backend.write(key, next);
        return next;
      }),
  };
}

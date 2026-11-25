import type { Deps } from "./deps";
import { createStore } from "./store";

/** chrome API の薄い実装。判断はすべて Deps を受け取る手順側に置く。 */
export function createChromeDeps(): Deps {
  return {
    fetch: globalThis.fetch.bind(globalThis),
    now: () => Date.now(),
    sleep: (ms) =>
      new Promise((resolve) => {
        setTimeout(resolve, ms);
      }),
    store: createStore({
      read: async (key) => (await chrome.storage.local.get(key))[key],
      write: (key, value) => chrome.storage.local.set({ [key]: value }),
    }),
    alarms: {
      create: (name, spec) =>
        chrome.alarms.create(
          name,
          spec.periodInMinutes === undefined
            ? { when: spec.when }
            : { when: spec.when, periodInMinutes: spec.periodInMinutes },
        ),
      clear: async (name) => {
        await chrome.alarms.clear(name);
      },
      get: (name) => chrome.alarms.get(name),
    },
    notifier: {
      show: async ({ id, title, message }) => {
        await chrome.notifications.create(id, {
          type: "basic",
          iconUrl: chrome.runtime.getURL("icons/icon128.png"),
          title,
          message,
        });
      },
    },
    randomId: () => crypto.randomUUID(),
  };
}

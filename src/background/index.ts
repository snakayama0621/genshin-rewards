import { createChromeDeps } from "./chrome-adapters";
import { handleCommand } from "./commands";
import { logError } from "./log";
import { urlForNotification } from "./notify";
import { ensureAlarms, handleAlarm, reconcile } from "./scheduler";

// Service Worker はイベントごとに起動し直すため、リスナーはトップレベルで同期的に登録する。
const deps = createChromeDeps();

function runLogged(context: string, task: Promise<unknown>): void {
  task.catch((error: unknown) => {
    logError(context, error);
  });
}

chrome.runtime.onInstalled.addListener(() => {
  runLogged("reconcile on install", reconcile(deps, "startup"));
});

chrome.runtime.onStartup.addListener(() => {
  runLogged("reconcile on startup", reconcile(deps, "startup"));
});

chrome.alarms.onAlarm.addListener((alarm) => {
  runLogged(`alarm ${alarm.name}`, handleAlarm(deps, alarm.name));
});

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  runLogged("command", handleCommand(deps, message).then(sendResponse));
  return true;
});

chrome.notifications.onClicked.addListener((id) => {
  const url = urlForNotification(id, chrome.runtime.getURL("options/options.html"));
  if (url !== null) runLogged("open notification target", chrome.tabs.create({ url }));
  runLogged("clear notification", chrome.notifications.clear(id));
});

runLogged("ensure alarms", ensureAlarms(deps));

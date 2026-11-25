import { commandSchema, parseStored } from "./schema";
import type {
  Command,
  CommandResponse,
  StorageKey,
  StorageSchema,
} from "./types";

const STORAGE_KEYS = [
  "settings",
  "session",
  "account",
  "checkin",
  "redeem",
  "history",
] as const satisfies readonly StorageKey[];

function isStorageKey(value: string): value is StorageKey {
  return (STORAGE_KEYS as readonly string[]).includes(value);
}

export async function readAllState(): Promise<StorageSchema> {
  const raw = await chrome.storage.local.get([...STORAGE_KEYS]);
  return {
    settings: parseStored("settings", raw.settings),
    session: parseStored("session", raw.session),
    account: parseStored("account", raw.account),
    checkin: parseStored("checkin", raw.checkin),
    redeem: parseStored("redeem", raw.redeem),
    history: parseStored("history", raw.history),
  };
}

export function onStateChanged(
  listener: (keys: readonly StorageKey[]) => void,
): () => void {
  const handler = (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string,
  ): void => {
    if (areaName !== "local") return;
    const keys = Object.keys(changes).filter(isStorageKey);
    if (keys.length > 0) listener(keys);
  };
  chrome.storage.onChanged.addListener(handler);
  return () => {
    chrome.storage.onChanged.removeListener(handler);
  };
}

export async function sendCommand(command: Command): Promise<CommandResponse> {
  const validated = commandSchema.parse(command);
  try {
    const response: unknown = await chrome.runtime.sendMessage(validated);
    if (isCommandResponse(response)) return response;
    return {
      ok: false,
      error: "バックグラウンドから不正な応答を受け取りました",
    };
  } catch {
    return { ok: false, error: "バックグラウンド処理に接続できませんでした" };
  }
}

function isCommandResponse(value: unknown): value is CommandResponse {
  if (typeof value !== "object" || value === null || !("ok" in value))
    return false;
  if (value.ok === true)
    return "message" in value && typeof value.message === "string";
  return (
    value.ok === false && "error" in value && typeof value.error === "string"
  );
}

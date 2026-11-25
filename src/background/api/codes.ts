import { z } from "zod";
import { isRedeemCode } from "../../shared/schema";
import type { RedeemCode } from "../../shared/types";
import type { Deps } from "../deps";
import { request } from "./http";

export const CODES_SOURCE_URL = "https://hoyo-codes.seria.moe/codes?game=genshin";
export const MAX_SOURCE_CODES = 50;

const listSchema = z.object({ codes: z.array(z.unknown()) });
const entrySchema = z.object({
  code: z.string(),
  status: z.string(),
  game: z.string(),
});

export type CodesResult =
  | { readonly kind: "ok"; readonly codes: readonly RedeemCode[] }
  | { readonly kind: "error"; readonly message: string };

/** 取得元のデータは信頼せず、有効な原神コードだけを重複なしで最大50件返す。 */
export function parseCodes(json: unknown): CodesResult {
  const list = listSchema.safeParse(json);
  if (!list.success) {
    return { kind: "error", message: "コード一覧の形式が正しくありません" };
  }
  const codes = list.data.codes.flatMap((item) => {
    const entry = entrySchema.safeParse(item);
    if (!entry.success) return [];
    const { code, status, game } = entry.data;
    return status === "OK" && game === "genshin" && isRedeemCode(code) ? [code] : [];
  });
  return { kind: "ok", codes: [...new Set(codes)].slice(0, MAX_SOURCE_CODES) };
}

export async function fetchCodes(deps: Deps): Promise<CodesResult> {
  const result = await request(deps, {
    url: new URL(CODES_SOURCE_URL),
    method: "GET",
    credentials: "omit",
  });
  switch (result.kind) {
    case "ok":
      return parseCodes(result.json);
    case "http_error":
      return { kind: "error", message: `HTTP ${String(result.status)}` };
    case "network_error":
      return { kind: "error", message: "通信に失敗しました" };
    case "timeout":
      return { kind: "error", message: "応答がタイムアウトしました" };
    default: {
      const exhaustive: never = result;
      return exhaustive;
    }
  }
}

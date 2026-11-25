/** 例外の種類だけを記録する（本文・UID・URLを含み得るメッセージは出さない）。 */
export function logError(context: string, error: unknown): void {
  console.error(`${context}: ${error instanceof Error ? error.name : "unknown error"}`);
}

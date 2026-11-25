/** 実行中なら同じPromiseを返し、手動と自動の重複実行を防ぐ。 */
export function singleFlight<A extends unknown[], T>(
  fn: (...args: A) => Promise<T>,
): (...args: A) => Promise<T> {
  let inFlight: Promise<T> | null = null;
  return (...args) => {
    if (inFlight !== null) return inFlight;
    const running = fn(...args).finally(() => {
      inFlight = null;
    });
    inFlight = running;
    return running;
  };
}

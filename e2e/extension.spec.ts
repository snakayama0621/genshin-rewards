import {
  chromium,
  expect,
  test,
  type BrowserContext,
  type Page,
  type Worker,
} from "@playwright/test";
import { parseStored } from "../src/shared/schema";
import type { StorageKey, StorageSchema } from "../src/shared/types";

// 実ブラウザ（Playwright の Chromium）に dist/ を読み込み、未ログインの状態で動作を確かめる。
// HoYoLAB / HoYoverse の公開エンドポイントへ実際に通信する（Cookie は送られない）。
const EXTENSION_PATH = new URL("../dist", import.meta.url).pathname;

let context: BrowserContext;
let serviceWorker: Worker;
let extensionId: string;

test.beforeAll(async () => {
  context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
    ],
  });
  serviceWorker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker"));
  extensionId = new URL(serviceWorker.url()).host;
});

test.afterAll(async () => {
  await context.close();
});

async function readStorage<K extends StorageKey>(
  key: K,
): Promise<StorageSchema[K]> {
  const raw: unknown = await serviceWorker.evaluate(
    async (k) => (await chrome.storage.local.get(k))[k],
    key,
  );
  return parseStored(key, raw);
}

async function openPage(
  path: string,
): Promise<{ page: Page; errors: string[] }> {
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto(`chrome-extension://${extensionId}/${path}`);
  return { page, errors };
}

test("Service Worker が起動し、自動実行は既定でオフ", async () => {
  const settings = await readStorage("settings");
  expect(settings.autoCheckin).toBe(false);
  expect(settings.redeemMode).toBe("off");
});

test("CSP により許可リスト外のホストへは通信できず、許可した取得元には届く", async () => {
  // no-cors なら CORS では失敗しないため、失敗すれば CSP（connect-src）が止めたことになる
  const reach = (url: string) =>
    serviceWorker.evaluate(async (target) => {
      try {
        await fetch(target, { mode: "no-cors", credentials: "omit" });
        return "reached";
      } catch {
        return "blocked";
      }
    }, url);
  expect(await reach("https://example.com/")).toBe("blocked");
  expect(await reach("https://hoyo-codes.seria.moe/codes?game=genshin")).toBe("reached");
});

for (const colorScheme of ["light", "dark"] as const) {
  test(`ポップアップがエラーなく、横にはみ出さずに表示される（${colorScheme}）`, async () => {
    const { page, errors } = await openPage("popup/popup.html");
    await page.emulateMedia({ colorScheme });
    await expect(
      page.getByRole("heading", { name: "ログインボーナス" }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "交換コード" })).toBeVisible();
    await expect(page.getByLabel("定期確認")).toHaveValue("off");
    const overflow = await page.evaluate(() =>
      [...document.querySelectorAll("body *")]
        .filter((el) => el.getBoundingClientRect().right > document.body.clientWidth)
        .map((el) => el.id || el.tagName),
    );
    expect(overflow).toEqual([]);
    expect(errors).toEqual([]);
    await page.close();
  });
}

test("未ログインで手動受取すると、実APIの -100 を受けて要ログインになる", async () => {
  const { page } = await openPage("popup/popup.html");
  await page.getByRole("button", { name: "今すぐ受取" }).click();
  await expect(page.getByText("要ログイン").first()).toBeVisible({
    timeout: 30_000,
  });
  const checkin = await readStorage("checkin");
  const session = await readStorage("session");
  const history = await readStorage("history");
  expect(checkin.result?.kind).toBe("not_logged_in");
  expect(session.hoyolab).toBe("expired");
  expect(
    history.some(
      (entry) => entry.task === "checkin" && entry.outcome === "failure",
    ),
  ).toBe(true);
  await page.close();
});

test("形式が不正な交換コードは送信せずに拒否される", async () => {
  const { page } = await openPage("popup/popup.html");
  await page.getByRole("textbox").fill("ABC-123!");
  await page.getByRole("button", { name: "引き換え", exact: true }).click();
  await expect(page.getByText("半角英数字").first()).toBeVisible();
  // 交換APIへ送っていれば redeem の履歴が残る（他のテストは交換APIを呼ばない）
  expect((await readStorage("history")).filter((entry) => entry.task === "redeem")).toEqual([]);
  await page.close();
});

test("設定画面で変更した設定が保存される", async () => {
  const { page, errors } = await openPage("options/options.html");
  await expect(
    page.getByRole("heading", { name: "利用上の注意" }),
  ).toBeVisible();
  await page.getByLabel("確認間隔").selectOption("6");
  await expect
    .poll(async () => (await readStorage("settings")).redeemIntervalHours)
    .toBe(6);
  expect(errors).toEqual([]);
  await page.close();
});

test("通知モードを選ぶと保存され、公開のコード一覧だけを確認して引き換えはしない", async () => {
  const { page, errors } = await openPage("options/options.html");
  await page.getByLabel("定期確認").selectOption({ label: "新しいコードを通知" });
  await expect
    .poll(async () => (await readStorage("settings")).redeemMode)
    .toBe("notify");
  // 有効にした直後の取りこぼし実行で、実際の hoyo-codes.seria.moe を確認する
  await expect
    .poll(async () => (await readStorage("redeem")).lastResult?.kind, { timeout: 30_000 })
    .toBe("checked");
  expect((await readStorage("redeem")).availableFetchedAt).not.toBeNull();
  expect((await readStorage("history")).filter((entry) => entry.task === "redeem")).toEqual([]);
  expect(await serviceWorker.evaluate(() => chrome.alarms.get("redeem"))).toBeDefined();
  expect(errors).toEqual([]);
  await page.close();
});

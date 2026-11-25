/** 拡張機能が開く公式ページ。リンクと通知のクリック先はこの表からだけ選び、外部データからURLを作らない。 */
export const OFFICIAL_PAGES = {
  hoyolab: "https://www.hoyolab.com/",
  gift: "https://genshin.hoyoverse.com/ja/gift",
  checkinPage:
    "https://act.hoyolab.com/ys/event/signin-sea-v3/index.html?act_id=e202102251931481",
} as const;

export type OfficialPage = keyof typeof OFFICIAL_PAGES;

# 設計書

原神のHoYoLABログインボーナス受取と交換コード引き換えを自動化する、個人用Chrome拡張機能（Manifest V3）の設計です。README は利用者向け、この文書は実装者向けです。

## 1. 調査で確定した外部仕様

推測で実装しないため、各仕様に根拠を付けます。「実測」は2026-11-24に未ログイン状態で実際に送ったリクエストの結果です。

### 1.1 ログインボーナス（HoYoLAB）

| 項目                | 内容                                                                                      | 根拠                                                                          |
| ------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 基底URL             | `https://sg-act-public-api.hoyolab.com/event/sol`                                         | 公式ログボページ `act.hoyolab.com/ys/event/signin-sea-v3/index.2921f9d330.js` |
| act_id              | `e202102251931481`                                                                        | 同上、genshin.py                                                              |
| 共通ヘッダー        | `x-rpc-signgame: hk4e`                                                                    | 公式ページのaxiosインターセプター、genshin.py                                 |
| 状態取得            | `GET /info?act_id=...&lang=ja-jp` → `data.is_sign`（bool）、`data.total_sign_day`（数値） | 公式ページ、genshin.py `get_reward_info`                                      |
| 受取                | `POST /sign?lang=ja-jp`、JSON本文 `{"act_id":"..."}`                                      | 公式ページ `ct("/sign", t, "post")`                                           |
| CAPTCHA             | 受取応答の `data.gt_result.is_risk === true`                                              | 公式ページ `handleSign`                                                       |
| CAPTCHA（補助判定） | `gt_result.risk_code !== 0 && gt && challenge && success !== 0`                           | genshin.py `check_for_geetest`                                                |
| 未ログイン          | `retcode -100`（実測: `{"data":null,"message":"ログインしてください","retcode":-100}`）   | 実測                                                                          |
| 受取済み            | `retcode -5003`                                                                           | genshin.py `AlreadyClaimed`                                                   |
| 日付切り替え        | UTC+8 の 0:00（日本時間 1:00）                                                            | genshin.py `CN_TIMEZONE`、参考サービスのREADME                                |

受取リクエストにUIDやサーバーは含まれません。そのため、受取報酬の送付先キャラクターを拡張機能から選ぶことはできません。

### 1.2 アカウント情報

| 項目        | 内容                                                                                                                      | 根拠                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| HoYoLAB側   | `GET https://api-account-os.hoyolab.com/account/binding/api/getUserGameRolesByCookieToken?game_biz=hk4e_global&lang=ja`   | 公式アカウントSDK（`hoyoverse-account-sdk/main.js`）がTLDを差し替えて呼ぶ。未ログインで `-100` を実測 |
| HoYoverse側 | `GET https://api-account-os.hoyoverse.com/account/binding/api/getUserGameRolesByCookieToken?game_biz=hk4e_global&lang=ja` | 公式ギフトページ `getCharacter`。未ログインで `-100` を実測                                           |
| 応答        | `data.list[]` の各要素に `game_biz`, `game_uid`, `nickname`, `level`, `region`, `region_name`                             | genshin.py `GenshinAccount`、公式ギフトページ（`n.list[0].game_uid`）                                 |

HoYoLAB側を先に呼び、`-100` なら HoYoverse 側を試します。

### 1.3 交換コードの引き換え（HoYoverse）

| 項目       | 内容                                                                                   | 根拠                                      |
| ---------- | -------------------------------------------------------------------------------------- | ----------------------------------------- |
| URL        | `GET https://public-operation-hk4e.hoyoverse.com/common/apicdkey/api/webExchangeCdkey` | 公式ギフトページ `redeemCode`、genshin.py |
| パラメータ | `uid`, `region`, `lang=ja`, `cdkey`, `game_biz=hk4e_global`                            | 公式ギフトページ `onSubmit`               |
| コード形式 | `/^[0-9A-Za-z]{1,30}$/`                                                                | 公式ギフトページ `checkCode`              |
| 認証       | `.hoyoverse.com` のCookie。HoYoLAB（`.hoyolab.com`）のログインとは別                   | Cookieのドメイン、参考サービスの案内      |
| 未ログイン | `retcode -1071`（実測）                                                                | 実測                                      |

| retcode                    | 意味                             | 扱い                                       |
| -------------------------- | -------------------------------- | ------------------------------------------ |
| -2001                      | 期限切れ                         | expired（確定）                            |
| -2003, -2004, -2014, -1065 | 無効・未有効化                   | invalid（確定）                            |
| -2006                      | 使用回数の上限                   | usage_limit（確定）                        |
| -2008                      | 地域が違う                       | region_locked（確定）                      |
| -2011, -2021               | 冒険ランク不足                   | level_too_low（確定）                      |
| -2016                      | 連続引き換えのクールダウン       | cooldown（今回の実行を止め、次回に再試行） |
| -2017, -2018               | 引き換え済み                     | already_redeemed（確定）                   |
| -1073                      | ゲームアカウントが紐づいていない | no_role                                    |
| -1071, -100                | 未ログイン                       | not_logged_in                              |

根拠は genshin.py `errors.py`。

### 1.4 共通の retcode

| retcode                  | 扱い                                     |
| ------------------------ | ---------------------------------------- |
| -110, 1028, 10101        | rate_limited                             |
| 10035, 5003, 10041, 1034 | captcha（genshin.py `GEETEST_RETCODES`） |

### 1.5 交換コードの取得元

`GET https://hoyo-codes.seria.moe/codes?game=genshin` を使います。応答は `{"codes":[{"code","status","game","rewards"}],"game"}` です（実測）。

| 候補                                                                     | 評価                                                                                                                                                                     |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| hoyo-codes.seria.moe                                                     | 採用。1時間ごとに複数サイトから収集し、実際に引き換えて有効なコードだけを返す。公開API、認証不要、OSS（GPL-3.0、ソースは流用しない）。個人運営のため継続性は保証されない |
| HoYoLAB公式の配布フィード（`bbs-api-os.hoyolab.com/.../guide/material`） | 不採用。生放送コードのみで、2026-11-24時点で `modules` が空だった                                                                                                        |
| 攻略Wiki等のHTML解析                                                     | 不採用。構造変更に弱く、利用規約上も不明確                                                                                                                               |

取得したデータは信頼しません。`status === "OK"` かつ `game === "genshin"` かつコード形式に一致するものだけを使い、重複を除き、最大50件に制限します。認証情報は一切送りません（`credentials: "omit"`）。

### 1.6 利用規約

原神利用規約（最終更新 2026-08-12）第9条1項20号は「外部ツール(BOT)もしくはCOGNOSPHERE PTE. LTD. から公式に提供していないプログラムを使用し、自分が有利にゲーム進行し、もしくは正常なサービス利用を妨げる行為」を禁止しています。違反時は第9条2項で警告、利用停止、報酬の取消しがあり得ます。

全プレイヤーが手動で受け取れる報酬の受取を自動化することが「有利なゲーム進行」に当たるかは明記されておらず、判断できません。そこで次の方針にします。

- 自動受取・交換コードの定期確認は既定でOFF。利用者が設定画面でリスクを確認して有効化する
- 定期確認の「通知」モードは公開の取得元（1.5）を読むだけで、HoYoLAB / HoYoverse には何も送らない。公式APIへ自動で送らずに新しいコードを知るための選択肢で、引き換えは利用者の手動操作で行う
- 公式Webページが送るリクエストと同じものだけを送り、署名（DS）の偽装やゲームクライアントの模倣はしない
- CAPTCHAが出たら自動処理を止める
- 送信頻度を手動操作と同程度に抑える

## 2. 技術選定

| 項目     | 選定                                            | 理由                                                                                            |
| -------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 言語     | TypeScript 6.0（strict）                        | typescript-eslint 8.74 が `<6.1` を要求するため 7.x は使わない                                  |
| UI       | フレームワークなし（DOM API）                   | ポップアップと設定画面だけなら依存を増やす利点が小さい。`innerHTML` 禁止をLintで強制しXSSを防ぐ |
| 入力検証 | Zod 4                                           | 利用者の規約（スキーマ検証はZod）。外部APIとストレージの境界で使う                              |
| バンドル | esbuild                                         | Zodをバンドルするため。設定は `scripts/build.mjs` の数行                                        |
| テスト   | Vitest                                          | TypeScriptをそのまま実行できる                                                                  |
| Lint     | ESLint + typescript-eslint（strictTypeChecked） |                                                                                                 |

## 3. アーキテクチャ

```
popup / options (UI, 読み取り専用)
   │ chrome.runtime.sendMessage(Command)      ▲ chrome.storage.onChanged
   ▼                                           │
background/index.ts (Service Worker、イベント配線のみ)
   │
   ├─ commands.ts     Command を検証して各処理へ振り分ける
   ├─ checkin.ts      ログボ受取の手順
   ├─ redeem.ts       交換コード引き換えの手順
   ├─ account.ts      キャラクター一覧の取得と対象選択
   ├─ scheduler.ts    アラームの計算・登録、起動時の取りこぼし判定
   ├─ notify.ts       設定に応じた通知
   ├─ history.ts      履歴の追記と上限管理
   ├─ api/http.ts     タイムアウト・再試行・送信間隔の制御
   ├─ api/hoyo.ts     HoYoLAB/HoYoverse のエンドポイント表、応答の検証、retcode の分類
   └─ api/codes.ts    交換コード取得元の呼び出しと検証
shared/ (UI とバックグラウンドの共通)
   types.ts  schema.ts  storage.ts  time.ts  labels.ts
```

依存の向きは `index.ts → commands/scheduler → checkin/redeem/account → api/*, history, notify → shared`。`api/*` は chrome API に依存しません。

### 3.1 依存の注入

手順モジュール（checkin, redeem, account, scheduler）は `Deps` を引数に取り、chrome API と `fetch` を直接呼びません。テストでは偽物を渡します。

```ts
interface Deps {
  fetch: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  store: Store; // 読み書き。update は直列化される
  alarms: AlarmPort; // create / clear / get
  notifier: NotifierPort;
  randomId: () => string;
}
```

### 3.2 状態と書き込み者

| キー       | 内容                                       | 書き込み者                                              |
| ---------- | ------------------------------------------ | ------------------------------------------------------- |
| `settings` | 利用者の設定                               | Service Worker（UI は `updateSettings` コマンドで依頼） |
| `session`  | HoYoLAB / HoYoverse それぞれのログイン状態 | Service Worker                                          |
| `account`  | キャラクター一覧                           | Service Worker                                          |
| `checkin`  | 当日のログボ結果と自動試行回数             | Service Worker                                          |
| `redeem`   | コードごとの結果、取得元の有効コード一覧   | Service Worker                                          |
| `history`  | 実行履歴                                   | Service Worker                                          |

書き込みは Service Worker だけが行い、`Store.update(key, fn)` を1本のPromiseチェーンで直列化します。手動実行と自動実行の重複は、処理ごとの single-flight（実行中なら同じPromiseを返す）で防ぎます。Service Worker はブラウザに1つしか存在しないため、メモリ上の制御で足ります。途中で停止しても、各手順は保存済みの状態から再開できるように作ります（冪等）。

UI はストレージを読むだけで、変更はすべてコマンド経由です。設定の検証は Service Worker の境界（`settingsPatchSchema`）で一度だけ行います。

## 4. 振る舞い

### 4.1 ログボ受取（checkin.ts）

1. 現在のゲーム内日付 `today = gameDayOf(now)` を求める。保存済み結果が `today` の claimed / already_claimed なら通信せずに終了する
2. `GET /info`。`is_sign` が true なら already_claimed として記録する
3. false なら `POST /sign`。CAPTCHA判定に当たれば captcha、`-5003` なら already_claimed、成功なら claimed（`total_sign_day` は info の値 + 1）
4. 結果を `checkin` に保存し、履歴に1件追記し、通知する
5. 自動実行（auto / startup / retry）では `autoAttempts` を1増やす。失敗（error / rate_limited / not_logged_in）で試行回数が3未満なら、`checkin-retry` アラームを「失敗の30分後」と「当日の実行予定」の遅いほうに登録する（失敗後に実行時刻を遅らせても、予定前に空振りしない）。captcha のときは再試行しない
6. 手動実行は captcha の後でも実行できる（利用者が公式ページで認証を済ませた後の確認に使う）

### 4.2 交換コード引き換え（redeem.ts）

一括実行（自動・手動の「今すぐ確認」）:

1. 対象キャラクターを決める（4.3）。いなければ no_role で終了
2. 取得元からコード一覧を取り、`redeem.available` を更新する。失敗したら source_error で終了
3. 対象UIDについて、確定状態（`TERMINAL_CODE_STATUSES`）のコードと、`failed` で試行3回以上のコードを除く
4. 残りを最大10件、1件ずつ引き換える。1件ごとに結果を保存する（途中停止しても次回は続きから）。交換APIへの送信間隔（6秒）は HTTP 層がホスト単位で守るので、一括実行と手動入力が重なっても間隔はあく
5. cooldown / not_logged_in / captcha / rate_limited / error を受けたら、その時点で実行を止める。error のときはそのコードを `failed`（attempts+1）にする
6. 交換APIが captcha を返したら、そのゲーム内日付を `redeem.captchaDay` に保存する（一括実行と手動入力のどちらでも）。その日はゲーム内日付が変わるまで自動の交換を実行しない（手動は可能）。`lastResult` は通知モードの確認でも上書きされるため、停止の判定には使わない

コード一覧の確認（定期確認の通知モード、`runCodeCheck`）:

1. 取得元からコード一覧を取る。失敗したら source_error を保存し、履歴に残し、失敗を通知する（一括実行と同じ）
2. 対象キャラクターは保存済みのキャラクター一覧と `settings.selectedUid` だけで決める（4.3 の選び方）。キャラクター一覧の取得はしない。HoYoLAB / HoYoverse へは通信しない
3. 1回の `Store.update` で、取得したコードのうち「前回の `redeem.available` にない」かつ「対象UIDで確定状態の記録がない」ものを新しいコードとして数え、`available`、`availableFetchedAt`、`lastRunAt`、`lastResult`（`{ kind: "checked", fresh }`）を保存する。キャラクターがいなければ記録による除外はしない
4. 新しいコードがあれば、最大5件のコードと残りの件数を通知する
5. 成功は履歴に残さない（1時間ごとの確認で履歴の上限300件を埋めないため）
6. 前回の一覧と比べるため、同じ一覧を何度確認しても2回目以降は通知しない（冪等）

手動入力の引き換え:

1. 前後の空白を除き、コード形式を検証する。違えば通信しない
2. 対象UIDで redeemed / already_redeemed の記録があれば「引き換え済み」として通信しない
3. 1件だけ引き換え、結果を保存する

コードの記録キーは `${uid}:${code}` です。記録は最大500件で、超えたら `updatedAt` の古い順に削除します。

### 4.3 アカウント（account.ts）

- HoYoLAB側 → HoYoverse側の順にキャラクター一覧を取得し、最初に成功した結果を保存する。`game_biz === "hk4e_global"` かつ UID・サーバーの形式が正しい要素だけを使う
- 取得は60秒に1回まで（UI を開くたびに通信しないため）
- 対象キャラクターは `settings.selectedUid` に一致するもの、なければ最もレベルが高いもの

### 4.4 ログイン状態（session）

- ログボの通信（info, sign）の結果で `session.hoyolab` を、HoYoverse側（引き換え、HoYoverse側のキャラクター取得）の結果で `session.hoyoverse` を更新する
- HoYoLAB側のキャラクター取得が `-100` を返しても `session.hoyolab` は変えない。このAPIがHoYoLABのログインで使えるかは未検証で、ログボが受け取れているのに「ログイン切れ」と通知するのを防ぐため。成功したときだけ active にする
- 成功なら active、not_logged_in なら expired
- expired に変わった瞬間だけ通知する（連続通知しない）

### 4.5 スケジューリング（scheduler.ts）

アラームは3つです。

| 名前            | 種類     | 時刻                                                                      |
| --------------- | -------- | ------------------------------------------------------------------------- |
| `checkin`       | 単発     | 次の実行予定（下記）                                                      |
| `checkin-retry` | 単発     | 失敗から30分後                                                            |
| `redeem`        | 繰り返し | 設定した間隔（1, 3, 6, 12, 24時間）。定期確認がオフ以外のときだけ登録する |

- 指定時刻 `checkinTime` はローカル時刻です。ゲーム内日付ごとに、その日の窓 [UTC+8 0:00, 翌0:00) の中で指定時刻に当たる瞬間 `checkinDueAt(day, time)` を実行予定とする
- 自動ログボが「実行すべき状態」とは、自動受取が有効、`now >= checkinDueAt(today)`、当日まだ claimed / already_claimed でない、当日 captcha でない、当日の自動試行が3回未満、のすべてを満たすこと
- `checkin` アラームは、当日が未完了で予定が未来ならその時刻、それ以外は翌日の予定に登録する
- `ensureAlarms` は現在の設定と状態から正しいアラームを計算し、差分だけ登録・削除する。Service Worker の起動、`onInstalled`、`onStartup`、設定変更、各処理の完了後に呼ぶ
- 定期確認のモード（`settings.redeemMode`）から実行する処理を決めるのは `redeemJob` の1か所だけ。`off` は何もしない、`notify` はコード一覧の確認（4.2）、`auto` は一括実行（4.2）。CAPTCHA による当日の停止（`redeem.captchaDay` が今日のゲーム内日付）は `auto` にだけ適用する
- `auto` では、前回の結果が通知モードの確認（`checked`）なら間隔を待たずに実行する。確認だけでは引き換えていないため、通知から自動に切り替えたらすぐ引き換える
- 取りこぼし対策: Service Worker の起動時（`onStartup` / `onInstalled`）と設定変更時に、ログボは上記の条件で、交換コードは「定期確認がオフ以外かつ前回実行から間隔以上経過」で即時実行する。スリープ中に過ぎたアラームは復帰時に Chrome が発火する
- 旧設定の `autoRedeem` は引き継がない。保存値の検証で既定値の `off` になる（安全側に倒す）

### 4.6 通知（notify.ts）

| 種類                   | 設定キー                                           | クリック時に開くページ                                                                                |
| ---------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| ログボ受取成功         | `checkinSuccess`                                   | なし                                                                                                  |
| 交換コード引き換え成功 | `redeemSuccess`                                    | なし                                                                                                  |
| 新しい交換コード       | なし（常に表示。通知モードを選んだこと自体が許可） | 公式交換サイト `https://genshin.hoyoverse.com/ja/gift`                                                |
| 失敗（captcha 含む）   | `failure`                                          | captcha ならログボの公式ページ、それ以外は設定画面                                                    |
| ログイン切れ           | `sessionExpired`                                   | HoYoLAB切れなら `https://www.hoyolab.com/`、HoYoverse切れなら `https://genshin.hoyoverse.com/ja/gift` |

通知IDにクリック先の種類を埋め込み、`onClicked` で URL を決めます。URL は固定の表から選び、外部データは使いません。

### 4.7 履歴（history.ts）

- 1件 = 日時、処理（checkin / redeem / account）、契機（auto / manual / startup / retry）、結果（success / skipped / failure）、メッセージ、交換コード（該当時のみ）
- 最大300件かつ30日以内。追記のたびに古いものを削る
- 通知モードのコード一覧の確認は、成功したときは記録しない。失敗（source_error）だけ記録する
- メッセージには API の `message` を含めてよいが、Cookie・トークン・リクエストヘッダーは含めない（そもそも拡張機能から読めない）

## 5. 制限値

| 名前                           | 値                                                               | 理由                                                       |
| ------------------------------ | ---------------------------------------------------------------- | ---------------------------------------------------------- |
| リクエストのタイムアウト       | 15秒                                                             |                                                            |
| GET の再試行                   | 最大2回（2秒、4秒待機）。ネットワークエラーと HTTP 5xx のみ      | POST（sign）は再試行しない。次の契機で info から確認し直す |
| 同一ホストへの最小送信間隔     | 1秒                                                              |                                                            |
| 交換の間隔                     | 6秒（HTTP 層で交換APIのホスト単位に適用）                        | `-2016`（クールダウン）を避ける                            |
| 1回の実行で引き換える最大件数  | 10件                                                             |                                                            |
| コードごとの最大試行回数       | 3回                                                              | 無限再試行を防ぐ                                           |
| ログボの自動試行               | 1日3回まで、間隔30分                                             |                                                            |
| 交換コードの確認間隔           | 1, 3, 6, 12, 24時間から選択（下限1時間）。通知モードと自動で共通 | 取得元の更新が1時間ごとのため                              |
| 新しいコードの通知に並べる件数 | 5件（残りは「ほか N 件」）                                       | 通知の本文に収めるため                                     |
| キャラクター取得               | 60秒に1回まで                                                    |                                                            |
| 履歴                           | 300件、30日                                                      |                                                            |
| コード記録                     | 500件                                                            |                                                            |

## 6. セキュリティ

- 権限は `storage`, `alarms`, `notifications` と、通信先5ホストの `host_permissions` だけ。`cookies` と `tabs` は要求しない
- CSP の `connect-src` を通信先5ホストに限定し、それ以外への通信をブラウザが拒否するようにする
- 認証は `fetch(..., { credentials: "include" })` でブラウザのCookieをそのまま使う。拡張機能のコードはCookieを読めず、保存も送信もしない
- 交換コード取得元への通信は `credentials: "omit"`
- 外部データ（API応答、コード一覧、ストレージ、メッセージ）は Zod で検証してから使う
- DOM は `textContent` と `createElement` だけで組み立てる（`innerHTML` などは ESLint で禁止）
- `eval`、`new Function`、外部スクリプトの読み込みはしない（MV3 と CSP、ESLint で禁止）
- `chrome.runtime.onMessage` は `sender.id === chrome.runtime.id` のメッセージだけ受け付ける
- ログ（`console.warn/error`）には retcode と分類だけを出し、応答本文やUIDは出さない
- API の `message` は200文字で切ってから履歴・通知に使う
- Zod は `z.config({ jitless: true })` で `new Function` を使わない設定にする（CSP が eval を禁止しているため）

## 7. テスト

| 種類                   | 対象                                                                                 | 実行                                            |
| ---------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------- |
| 単体・結合（モック）   | 時刻計算、応答の検証、retcode 分類、各手順、スケジュール判定、履歴の上限、設定の検証 | `npm test`                                      |
| 実通信（未ログイン）   | 拡張機能の読み込み、ポップアップ表示、未ログイン時の挙動                             | 手動または Playwright（`docs/VERIFICATION.md`） |
| 実通信（ログイン済み） | 実際の受取・引き換え                                                                 | 利用者が手動で確認（`docs/VERIFICATION.md`）    |

モックは `fetch`（外部サービス）と chrome API（Node では動かない）だけに使います。手順のテストは、偽の `fetch` が受け取ったリクエスト（URL、メソッド、ヘッダー、本文）と、保存された状態を検証します。応答の固定データは、実測した応答と、根拠のある資料のフィールド名から作ります。

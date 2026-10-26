# コード抜粋の読み方

[全体像](../README.md) / [設計事例](../case-studies/shipment-inventory.md) / [検証記録](../docs/verification.md)

実運用中の非公開リポジトリ（業務アプリ）から、**読みどころになる純粋な処理とそのテスト**だけを取り出したものです。

- 本番のデータベース・認証設定・元の開発履歴は収録していません。公開範囲の確認は、資料の編集とは別に行います。
- 他のファイル（型定義・ヘルパー・Firebase 連携）に依存しているため、**単体では動きません**。ロジックと、それを守るテストを読んでいただく目的です。
- 元アプリの2026-10-14時点の通過記録は[検証記録](../docs/verification.md)に記載しています。今回の資料更新で、抜粋単体のテストを再実行した結果ではありません。
- 提出用コピーでは、取引先を表すキーをsamplePartyA・samplePartyB、取引先IDを910001〜910003というダミーに変更しています。取引先名を含むコメントは省略しています。実環境の取引先設定としては利用できません。

## 出荷管理アプリ（`shipment-management/`）

| ファイル | 読みどころ |
|---|---|
| [在庫計算](./shipment-management/utils/inventoryFifo.ts) | 委託先の店頭在庫を、納品・販売・賞味期限切れから先入れ先出しで日次に計算する。マイナスの繰越、実在庫の手動補正、途中の保存状態からの再開に対応 |
| [途中再開の一致](./shipment-management/tests/inventoryFifo.snapshotEquivalence.test.ts) | 途中から計算した結果が、全期間を計算し直した結果と一致すること |
| [手動補正](./shipment-management/tests/inventoryFifo.manualStock.test.ts) | 実在庫の手動補正（ロス計上・積み増し）の境界 |
| [販売の繰越](./shipment-management/tests/inventoryFifo.carriedOverSales.test.ts) | 前の期間から繰り越した販売の扱い |
| [出荷確定時のID](./shipment-management/tests/materializeShipmentDocId.test.ts) | 定期購入から予定した出荷を、実際の出荷へ確定するときの識別子の決め方 |

## 経営ダッシュボード（`management-dashboard/`）

| ファイル | 読みどころ |
|---|---|
| [入金の突合](./management-dashboard/aggregations/reconciliation.ts) | アプリ側の売上と会計側の入金を突き合わせる処理。割合と金額の両方による許容差、締め周期、候補の入金を探す期間 |
| [金額・日付の境界](./management-dashboard/aggregations/reconciliation.test.ts) | 許容誤差ちょうど・超過・月またぎ・年またぎを固定するテスト |
| [締めの権限](./management-dashboard/permission/closePermission.ts) | 月次の締めを実行できる人の判定 |
| [権限のテスト](./management-dashboard/permission/closePermission.test.ts) | 許可された人・されない人・未ログインの扱い |

## 読み方のヒント

- 日付・金額・割合を扱う処理は、**境界の値**（ちょうど・1 円超過・月の変わり目）をテストで固定しています。仕様の決め直しがあった場合は、コメントに「いつ・何を・なぜ」変えたかを残しています。
- 業務の判断（許容誤差を 1% から 3% に緩めた等）は、作者が決め、その経緯をコメントに記録しています。

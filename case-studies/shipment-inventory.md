# 出荷管理：途中から再計算しても、同じ在庫になること

[全体像](../README.md) / [アプリ一覧](../docs/app-catalog.md) / [コード抜粋](../code-samples/README.md)

## 現場で扱うこと

出荷管理アプリは、注文に応じた出荷の予定と記録を扱います。単発購入・定期購入・ギフト・卸・ふるさと納税・加工品・委託などの販路に対応しています。

この事例は、卵を委託先へ納品した後の在庫です。納品した数から、売れた分と賞味期限を過ぎた分を差し引いて、残りを計算します。実際に数えた在庫と合わない場合の補正も扱います。
その計算を途中から再開しても答えが変わらないことを、処理とテストの対で紹介します。

## 作者が決めた条件

- 納品・販売・賞味期限切れをもとに、先に入ったものから計算する。
- 実在庫の確認による手動補正と、前期間からの販売の繰越を扱う。
- 途中の保存済み状態から再開する場合も、全期間を最初から再計算した結果と一致させる。

最後の条件を、計算を省略しても守るべき基準としてテストにしています。

## 実装と、読む順番

| 順番 | 対象 | 注目する点 |
|---|---|---|
| 1 | [在庫計算](../code-samples/shipment-management/utils/inventoryFifo.ts) | 日次に進む計算と、保存状態の引継ぎ |
| 2 | [途中再開と全期間の一致](../code-samples/shipment-management/tests/inventoryFifo.snapshotEquivalence.test.ts) | 同じ入力を異なる再計算経路で比較する |
| 3 | [手動補正](../code-samples/shipment-management/tests/inventoryFifo.manualStock.test.ts) | 実在庫を補正した場合の境界 |
| 4 | [販売の繰越](../code-samples/shipment-management/tests/inventoryFifo.carriedOverSales.test.ts) | 前期間からの販売を次の期間へ渡す条件 |

別の抜粋として、[定期購入から出荷を確定する際のIDのテスト](../code-samples/shipment-management/tests/materializeShipmentDocId.test.ts)も収録しています。

## 確認できることと限界

処理とテストを対にして、どの業務条件を固定したかを読めます。
元の出荷管理アプリは2026-10-14に733件通過、別途9件スキップの記録があります。これは抜粋だけのテスト件数ではありません。
型定義や他の処理を省いており、この資料単体で実行できるデモではありません。

[次の事例：入金と月次締め](./month-end-review.md) / [検証記録](../docs/verification.md)

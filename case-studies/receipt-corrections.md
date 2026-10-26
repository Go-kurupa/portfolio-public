# 領収書保管：AIの提案を、人が確認して記録へ反映する

[全体像](../README.md) / [アプリ一覧](../docs/app-catalog.md) / [領収書保管の実装](https://github.com/Go-kurupa/receipt-vault-public)

## 使う場面

個人事業の領収書をスマートフォンから保管し、ClaudeやChatGPTから検索・整理するアプリです。
会話から記録を訂正するときも、対象と変更内容を人が確かめられるようにしています。端末ではPixelからの利用を確認しています。

## 説明用の一巡

以下は架空の利用例です。実データや実行ログではありません。

1. 「未仕訳の領収書を見せて」と依頼し、候補を確認する。
2. 架空の1件について、科目を「消耗品費」、メモを「梱包用資材」とする下書きを作る。
3. 対象と変更前後を人が確認する。
4. 了承後に適用し、新しい版と結果を確認する。

## 作者が決めた条件と実装

| 条件 | 実装 |
|---|---|
| 訂正を確認してから進める | 下書きと適用を別の処理にする |
| 元の記録をたどれる | 元の版を残し、新しい版を追記する |
| 同じ要求の再送で二重処理しない | 要求の記録と領収書の記録をまとめて保存する |
| AIから変更する範囲を限定する | 科目・メモ・案件・按分・状態・仕訳番号を対象にし、鍵ごとの権限も分ける |

日付・金額・取引先の訂正、削除、新規登録は画面から行います。
下書きと適用を分ける設計は、人の確認を運用で省略してよいという意味ではありません。

## 実装へ進む

- [整理の処理](https://github.com/Go-kurupa/receipt-vault-public/blob/main/mcp/src/write/tools.ts)
- [版管理](https://github.com/Go-kurupa/receipt-vault-public/blob/main/functions/src/versioning.ts)
- [要求の重複防止](https://github.com/Go-kurupa/receipt-vault-public/blob/main/functions/src/idempotency.ts)

領収書保管は別リポジトリの応募用コピーです。実データと配備設定は含めず、自分の環境を用意する前提です。
2026-10-14の通過記録は、画面108件・Cloud Functions 38件・MCPサーバー285件の計431件です。

[開発の進め方](../docs/development-process.md) / [検証記録](../docs/verification.md)

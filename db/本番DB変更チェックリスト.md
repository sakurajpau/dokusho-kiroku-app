# 本番DBを変更する時の安全な段取り

## ① バックアップ
- [ ] `node db/backup.js` を実行し、`backups/` に最新データを保存した
- [ ] （本番に対して実行する場合）`APP_URL=https://dokusho-kiroku-app.onrender.com node db/backup.js`

## ② staging（手元）で検証
- [ ] 変更用のブランチを作った
- [ ] マイグレーションファイルを `db/migrations/` に追加した
- [ ] 手元で `rm -f data.db && node server.js` して、マイグレーションがエラーなく通ることを確認した
- [ ] `npm test` が全件成功した
- [ ] 既存データが壊れていない（件数・内容が変わっていない）ことを確認した

## ③ 本番へ反映
- [ ] PRを作成し、CIが緑になった
- [ ] マージした
- [ ] 本番（Render）が自動デプロイされ、正常に起動したことを確認した
- [ ] 本番のデータが消えていない・壊れていないことを確認した

## もし壊れたら
- [ ] `node db/restore.js backups/（①で保存したファイル）` で戻す
- [ ] （本番に対して実行する場合）`APP_URL=https://dokusho-kiroku-app.onrender.com node db/restore.js backups/xxxx.json`

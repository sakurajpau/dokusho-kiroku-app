const fs = require("fs");
const path = require("path");

const APP_URL = process.env.APP_URL || "http://localhost:3100";
const BACKUP_DIR = path.join(__dirname, "..", "backups");

async function main() {
  const res = await fetch(`${APP_URL}/api/books`);
  if (!res.ok) {
    console.error("バックアップ失敗: サーバーから取得できませんでした", res.status);
    process.exit(1);
  }
  const books = await res.json();

  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(BACKUP_DIR, `backup_${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(books, null, 2), "utf8");

  console.log(`バックアップ完了: ${file}（${books.length}件）`);
}

main();

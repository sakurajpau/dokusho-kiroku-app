const fs = require("fs");
const path = require("path");

const APP_URL = process.env.APP_URL || "http://localhost:3100";
const file = process.argv[2];

async function main() {
  if (!file) {
    console.error("使い方: node db/restore.js backups/backup_xxxx.json");
    process.exit(1);
  }
  const fullPath = path.isAbsolute(file) ? file : path.join(process.cwd(), file);
  if (!fs.existsSync(fullPath)) {
    console.error(`ファイルが見つかりません: ${fullPath}`);
    process.exit(1);
  }
  const books = JSON.parse(fs.readFileSync(fullPath, "utf8"));

  const res = await fetch(`${APP_URL}/api/books`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(books),
  });
  const result = await res.json();
  if (!result.ok) {
    console.error("復元失敗:", result.error);
    process.exit(1);
  }
  console.log(`復元完了: ${books.length}件を反映しました`);
}

main();

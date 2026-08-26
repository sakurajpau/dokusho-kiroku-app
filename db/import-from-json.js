const fs = require("fs");
const path = require("path");

function importFromJson(db, jsonPath) {
  if (!fs.existsSync(jsonPath)) return 0;
  const books = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  const insert = db.prepare(
    `INSERT OR REPLACE INTO books (id, title, author, date, memo, rating, category)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  for (const b of books) {
    insert.run(b.id, b.title, b.author || "", b.date || "", b.memo || "", b.rating || 0, b.category || "");
  }
  return books.length;
}

if (require.main === module) {
  const { openDb } = require("./connection");
  const JSON_PATH = path.join(__dirname, "..", "books.json");
  const DB_PATH = path.join(__dirname, "..", "data.db");
  const db = openDb(DB_PATH);
  const count = importFromJson(db, JSON_PATH);
  console.log(`${count}件を books.json から data.db に取り込みました。`);
  db.close();
}

module.exports = { importFromJson };

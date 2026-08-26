const { DatabaseSync } = require("node:sqlite");
const fs = require("fs");
const path = require("path");

function runMigrations(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);

  const appliedRows = db.prepare("SELECT name FROM _migrations").all();
  const applied = new Set(appliedRows.map((r) => r.name));

  const dir = path.join(__dirname, "migrations");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(dir, file), "utf8");
    db.exec(sql);
    db.prepare("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)").run(
      file,
      new Date().toISOString()
    );
    console.log(`マイグレーション適用: ${file}`);
  }
}

function openDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  runMigrations(db);
  return db;
}

module.exports = { openDb, runMigrations };

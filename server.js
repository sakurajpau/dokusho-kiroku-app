const http = require("http");
const fs = require("fs");
const path = require("path");
const { openDb } = require("./db/connection");
const { importFromJson } = require("./db/import-from-json");

const PORT = process.env.PORT || 3100;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data.db");
const db = openDb(DB_PATH);

// 初回起動時、data.dbが空ならbooks.jsonから取り込む（ephemeralなホスティングでの自動復元用）
const bookCount = db.prepare("SELECT COUNT(*) AS n FROM books").get().n;
if (bookCount === 0) {
  importFromJson(db, path.join(__dirname, "books.json"));
}

function loadBooks(){
  return db.prepare("SELECT * FROM books ORDER BY id").all();
}

function saveBooks(books){
  const del = db.prepare("DELETE FROM books");
  const insert = db.prepare(
    `INSERT INTO books (id, title, author, date, memo, rating, category, pages)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  db.exec("BEGIN");
  try {
    del.run();
    for (const b of books) {
      insert.run(
        b.id, b.title, b.author || "", b.date || "",
        b.memo || "", b.rating || 0, b.category || "", b.pages || null
      );
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

function serveStatic(req, res){
  const urlPath = req.url === "/" ? "/index.html" : req.url.split("?")[0];
  const filePath = path.join(__dirname, decodeURIComponent(urlPath));
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end("Not found");
    }
    const type = MIME[path.extname(filePath)] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": `${type}; charset=utf-8` });
    res.end(data);
  });
}

function handleGetBooks(req, res){
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(loadBooks()));
}

function handleSaveBooks(req, res){
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    try{
      const books = JSON.parse(body);
      saveBooks(books);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true }));
    }catch(e){
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  });
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/api/books") && req.method === "GET") return handleGetBooks(req, res);
  if (req.url.startsWith("/api/books") && req.method === "POST") return handleSaveBooks(req, res);
  return serveStatic(req, res);
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`読書記録アプリ起動中: http://localhost:${PORT}`);
  });
}

module.exports = server;

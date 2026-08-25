const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3100;
const DATA_FILE = path.join(__dirname, "books.json");

function loadBooks(){
  try{
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  }catch(e){
    return [];
  }
}

function saveBooks(books){
  fs.writeFileSync(DATA_FILE, JSON.stringify(books, null, 2), "utf8");
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

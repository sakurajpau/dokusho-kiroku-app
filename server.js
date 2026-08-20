const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3100;
const DATA_FILE = path.join(__dirname, "books.json");

function loadBooks(){
  try{
    const data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    return Array.isArray(data) ? data : [];
  }catch(e){
    return [];
  }
}

const LIMITS = { title: 100, author: 60, memo: 500 };

// クライアントからの入力は信用せず、保存前に必ず正しい形へそろえる
function sanitizeBook(raw){
  if(typeof raw !== "object" || raw === null) return null;
  const title = typeof raw.title === "string" ? raw.title.trim().slice(0, LIMITS.title) : "";
  if(!title) return null;
  const rating = Number(raw.rating);
  return {
    id: Number.isFinite(Number(raw.id)) ? Number(raw.id) : Date.now(),
    title,
    author: typeof raw.author === "string" ? raw.author.trim().slice(0, LIMITS.author) : "",
    date: typeof raw.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.date) ? raw.date : "",
    memo: typeof raw.memo === "string" ? raw.memo.trim().slice(0, LIMITS.memo) : "",
    category: typeof raw.category === "string" && raw.category ? raw.category : "自己啓発",
    rating: Number.isFinite(rating) ? Math.min(5, Math.max(0, Math.round(rating))) : 0,
  };
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

const MAX_BODY_SIZE = 2 * 1024 * 1024; // 2MB — 極端に大きい送信でサーバーが落ちないよう上限を設ける

function handleSaveBooks(req, res){
  let body = "";
  let tooLarge = false;
  req.on("data", (chunk) => {
    if(tooLarge) return;
    body += chunk;
    if(body.length > MAX_BODY_SIZE){
      tooLarge = true;
      res.writeHead(413, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "データが大きすぎます" }));
      req.destroy();
    }
  });
  req.on("end", () => {
    if(tooLarge) return;
    let parsed;
    try{
      parsed = JSON.parse(body);
    }catch(e){
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "データの形式が正しくありません" }));
      return;
    }
    if(!Array.isArray(parsed)){
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "本の一覧はリスト形式で送ってください" }));
      return;
    }
    const books = parsed.map(sanitizeBook).filter(Boolean);
    if(books.length !== parsed.length){
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "タイトルが空の本があります" }));
      return;
    }
    try{
      saveBooks(books);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true }));
    }catch(e){
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "保存に失敗しました" }));
    }
  });
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/api/books") && req.method === "GET") return handleGetBooks(req, res);
  if (req.url.startsWith("/api/books") && req.method === "POST") return handleSaveBooks(req, res);
  return serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`読書記録アプリ起動中: http://localhost:${PORT}`);
});

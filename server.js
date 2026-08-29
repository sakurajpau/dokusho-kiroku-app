const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Stripe = require("stripe");
const { openDb } = require("./db/connection");
const { importFromJson } = require("./db/import-from-json");

const PORT = process.env.PORT || 3100;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data.db");
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "sakurajpau";
const FREE_BOOK_LIMIT = 10;
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
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
  const pathOnly = req.url.split("?")[0];
  const urlPath = pathOnly === "/" ? "/index.html" : pathOnly;
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

function handleSaveBooks(req, res, user){
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    try{
      const books = JSON.parse(body);
      if(user.plan !== "paid" && books.length > FREE_BOOK_LIMIT){
        res.writeHead(402, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({
          ok: false,
          error: `無料プランは${FREE_BOOK_LIMIT}冊までです。無制限プランへのアップグレードをご検討ください。`,
        }));
      }
      saveBooks(books);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true }));
    }catch(e){
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  });
}

function handleHealth(req, res){
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ ok: true, time: new Date().toISOString() }));
}

// ---- 認証（サインアップ・ログイン・ログアウト・セッション・パスワード再発行・権限） ----

function hashPassword(password){
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored){
  const [salt, hash] = stored.split(":");
  const check = crypto.scryptSync(password, salt, 64);
  const original = Buffer.from(hash, "hex");
  if (check.length !== original.length) return false;
  return crypto.timingSafeEqual(check, original);
}

function parseCookies(req){
  const header = req.headers.cookie || "";
  const out = {};
  header.split(";").forEach((part) => {
    const idx = part.indexOf("=");
    if (idx === -1) return;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  });
  return out;
}

function createSession(userId){
  const token = crypto.randomBytes(32).toString("hex");
  db.prepare("INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)")
    .run(token, userId, new Date().toISOString());
  return token;
}

function getSessionUser(req){
  const cookies = parseCookies(req);
  const token = cookies.session;
  if (!token) return null;
  const row = db.prepare(
    `SELECT users.id, users.username, users.role, users.plan FROM sessions
     JOIN users ON users.id = sessions.user_id
     WHERE sessions.token = ?`
  ).get(token);
  return row || null;
}

function readJsonBody(req){
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, obj){
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

async function handleSignup(req, res){
  let body;
  try { body = await readJsonBody(req); } catch (e) { return sendJson(res, 400, { ok: false, error: "リクエストの形式が正しくありません" }); }
  const username = (body.username || "").trim();
  const password = body.password || "";
  if (!username || username.length < 3) return sendJson(res, 400, { ok: false, error: "ユーザー名は3文字以上にしてください" });
  if (!password || password.length < 8) return sendJson(res, 400, { ok: false, error: "パスワードは8文字以上にしてください" });

  const existing = db.prepare("SELECT id FROM users WHERE username = ?").get(username);
  if (existing) return sendJson(res, 400, { ok: false, error: "そのユーザー名はすでに使われています" });

  const role = username === ADMIN_USERNAME ? "admin" : "member"; // 管理者は決まったユーザー名の人だけ
  const passwordHash = hashPassword(password);
  const info = db.prepare(
    "INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)"
  ).run(username, passwordHash, role, new Date().toISOString());

  const token = createSession(info.lastInsertRowid);
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Set-Cookie": `session=${token}; HttpOnly; Path=/; SameSite=Lax`,
  });
  res.end(JSON.stringify({ ok: true, username, role, plan: "free" }));
}

async function handleLogin(req, res){
  let body;
  try { body = await readJsonBody(req); } catch (e) { return sendJson(res, 400, { ok: false, error: "リクエストの形式が正しくありません" }); }
  const username = (body.username || "").trim();
  const password = body.password || "";
  const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username);
  if (!user || !verifyPassword(password, user.password_hash)) {
    return sendJson(res, 401, { ok: false, error: "ユーザー名またはパスワードが違います" });
  }
  const token = createSession(user.id);
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Set-Cookie": `session=${token}; HttpOnly; Path=/; SameSite=Lax`,
  });
  res.end(JSON.stringify({ ok: true, username: user.username, role: user.role, plan: user.plan }));
}

function handleLogout(req, res){
  const cookies = parseCookies(req);
  if (cookies.session) {
    db.prepare("DELETE FROM sessions WHERE token = ?").run(cookies.session);
  }
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Set-Cookie": "session=; HttpOnly; Path=/; Max-Age=0",
  });
  res.end(JSON.stringify({ ok: true }));
}

function handleMe(req, res){
  const user = getSessionUser(req);
  sendJson(res, 200, { ok: true, user });
}

async function handleRequestReset(req, res){
  let body;
  try { body = await readJsonBody(req); } catch (e) { return sendJson(res, 400, { ok: false, error: "リクエストの形式が正しくありません" }); }
  const username = (body.username || "").trim();
  const user = db.prepare("SELECT id FROM users WHERE username = ?").get(username);
  if (!user) {
    // ユーザーの有無を外部に漏らさないため、常に同じ返事にする
    return sendJson(res, 200, { ok: true });
  }
  const token = crypto.randomBytes(20).toString("hex");
  const expires = new Date(Date.now() + 30 * 60 * 1000).toISOString(); // 30分
  db.prepare("UPDATE users SET reset_token = ?, reset_token_expires = ? WHERE id = ?")
    .run(token, expires, user.id);
  // 本来はメール送信。今回は開発用にサーバーログへ出力する。
  console.log(`[パスワード再発行] ${username} 用のトークン: ${token}`);
  sendJson(res, 200, { ok: true, devToken: token });
}

async function handleCompleteReset(req, res){
  let body;
  try { body = await readJsonBody(req); } catch (e) { return sendJson(res, 400, { ok: false, error: "リクエストの形式が正しくありません" }); }
  const token = body.token || "";
  const newPassword = body.newPassword || "";
  if (!newPassword || newPassword.length < 8) return sendJson(res, 400, { ok: false, error: "パスワードは8文字以上にしてください" });

  const user = db.prepare(
    "SELECT * FROM users WHERE reset_token = ? AND reset_token_expires > ?"
  ).get(token, new Date().toISOString());
  if (!user) return sendJson(res, 400, { ok: false, error: "トークンが無効か、期限切れです" });

  db.prepare("UPDATE users SET password_hash = ?, reset_token = NULL, reset_token_expires = NULL WHERE id = ?")
    .run(hashPassword(newPassword), user.id);
  sendJson(res, 200, { ok: true });
}

// ---- 課金（Stripeテストモード：無制限プランのチェックアウト） ----

function originOf(req){
  const proto = req.headers["x-forwarded-proto"] || "http";
  return `${proto}://${req.headers.host}`;
}

async function handleCreateCheckout(req, res, user){
  if(!stripe) return sendJson(res, 500, { ok: false, error: "決済が設定されていません（STRIPE_SECRET_KEYが未設定）" });
  const origin = originOf(req);
  try{
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{
        price_data: {
          currency: "jpy",
          product_data: { name: "読書記録アプリ 無制限プラン" },
          unit_amount: 500,
          recurring: { interval: "month" },
        },
        quantity: 1,
      }],
      success_url: `${origin}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/?checkout=cancel`,
      client_reference_id: String(user.id),
    });
    sendJson(res, 200, { ok: true, url: session.url });
  }catch(e){
    sendJson(res, 500, { ok: false, error: e.message });
  }
}

async function handleConfirmCheckout(req, res, user){
  if(!stripe) return sendJson(res, 500, { ok: false, error: "決済が設定されていません（STRIPE_SECRET_KEYが未設定）" });
  const url = new URL(req.url, "http://localhost");
  const sessionId = url.searchParams.get("session_id");
  if(!sessionId) return sendJson(res, 400, { ok: false, error: "session_idがありません" });
  try{
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if(session.client_reference_id !== String(user.id) || session.payment_status !== "paid"){
      return sendJson(res, 400, { ok: false, error: "支払いが確認できませんでした" });
    }
    db.prepare("UPDATE users SET plan = 'paid' WHERE id = ?").run(user.id);
    sendJson(res, 200, { ok: true, plan: "paid" });
  }catch(e){
    sendJson(res, 500, { ok: false, error: e.message });
  }
}

function requireLogin(req, res){
  const user = getSessionUser(req);
  if (!user) {
    sendJson(res, 401, { ok: false, error: "ログインが必要です" });
    return null;
  }
  return user;
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/health")) return handleHealth(req, res);
  if (req.url === "/api/signup" && req.method === "POST") return handleSignup(req, res);
  if (req.url === "/api/login" && req.method === "POST") return handleLogin(req, res);
  if (req.url === "/api/logout" && req.method === "POST") return handleLogout(req, res);
  if (req.url === "/api/me" && req.method === "GET") return handleMe(req, res);
  if (req.url === "/api/password-reset/request" && req.method === "POST") return handleRequestReset(req, res);
  if (req.url === "/api/password-reset/complete" && req.method === "POST") return handleCompleteReset(req, res);

  if (req.url.startsWith("/api/books") && req.method === "GET") {
    if (!requireLogin(req, res)) return;
    return handleGetBooks(req, res);
  }
  if (req.url.startsWith("/api/books") && req.method === "POST") {
    const user = requireLogin(req, res);
    if (!user) return;
    if (user.role !== "admin") {
      return sendJson(res, 403, { ok: false, error: "編集は管理者(admin)だけができます" });
    }
    return handleSaveBooks(req, res, user);
  }
  if (req.url === "/api/checkout" && req.method === "POST") {
    const user = requireLogin(req, res);
    if (!user) return;
    return handleCreateCheckout(req, res, user);
  }
  if (req.url.startsWith("/api/checkout/confirm") && req.method === "GET") {
    const user = requireLogin(req, res);
    if (!user) return;
    return handleConfirmCheckout(req, res, user);
  }
  return serveStatic(req, res);
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`読書記録アプリ起動中: http://localhost:${PORT}`);
  });
}

module.exports = server;

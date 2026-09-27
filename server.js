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
const RECOMMEND_MONTHLY_LIMIT = 20;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || null;
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const LOGIN_MAX_ATTEMPTS = 3;
const LOGIN_LOCK_MS = 15 * 60 * 1000; // 15分
const db = openDb(DB_PATH);

// ---- 入力の上限(長すぎる入力や壊れたデータでサーバーが止まらないようにする) ----
const MAX_AUTH_BODY_BYTES = 16 * 1024;         // ログイン・登録など: 16KB
const MAX_BOOKS_BODY_BYTES = 10 * 1024 * 1024; // 本の一覧: 10MB
const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;    // Stripeからの通知: 1MB
const MAX_BOOKS = 1000;
const USERNAME_MIN = 3;
const USERNAME_MAX = 50;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 200;
const BOOK_LIMITS = { title: 200, author: 100, memo: 5000, category: 30, pagesMax: 100000 };
const GENERIC_SERVER_ERROR = "サーバーで問題が起きました。しばらくしてからもう一度お試しください。";
const BAD_REQUEST_ERROR = "リクエストの形式が正しくありません。ページを読み込み直してからもう一度お試しください。";

// 利用者にそのまま見せてよい「理由つきのエラー」。statusはHTTPの状態コード。
class HttpError extends Error {
  constructor(status, message){
    super(message);
    this.status = status;
  }
}

function logAudit(username, action, detail){
  db.prepare("INSERT INTO audit_log (username, action, detail, created_at) VALUES (?, ?, ?, ?)")
    .run(username || null, action, detail || null, new Date().toISOString());
}

// ---- ログイン総当たり対策(レート制限) ----
// サーバーを再起動するとリセットされる、メモリ上だけの簡易な仕組み。
const loginAttempts = new Map(); // username -> { count, lockedUntil }

function checkLoginLock(username){
  const entry = loginAttempts.get(username);
  if(!entry) return null;
  if(entry.lockedUntil && entry.lockedUntil > Date.now()){
    return Math.ceil((entry.lockedUntil - Date.now()) / 60000);
  }
  return null;
}

function recordLoginFailure(username){
  // 記録が増えすぎてメモリを圧迫しないよう、多くなったら期限切れの記録を掃除する
  if(loginAttempts.size > 5000){
    const now = Date.now();
    for(const [name, e] of loginAttempts){
      if(!e.lockedUntil || e.lockedUntil <= now) loginAttempts.delete(name);
    }
  }
  const entry = loginAttempts.get(username) || { count: 0, lockedUntil: 0 };
  entry.count += 1;
  if(entry.count >= LOGIN_MAX_ATTEMPTS){
    entry.lockedUntil = Date.now() + LOGIN_LOCK_MS;
    entry.count = 0;
  }
  loginAttempts.set(username, entry);
}

function clearLoginFailures(username){
  loginAttempts.delete(username);
}

// 初回起動時、data.dbが空ならbooks.jsonから取り込む（ephemeralなホスティングでの自動復元用）
const bookCount = db.prepare("SELECT COUNT(*) AS n FROM books").get().n;
if (bookCount === 0) {
  try {
    importFromJson(db, path.join(__dirname, "books.json"));
  } catch (e) {
    // books.jsonが壊れていても、アプリ自体は起動できるようにする
    console.warn("books.jsonの取り込みをスキップしました:", e.message);
  }
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

// 公開してよいのは、フォルダ直下のHTMLページ(index.html, terms.html など)だけ。
// server.js・data.db・books.json・.env などは、URLを直接指定されても返さない。
const PUBLIC_PAGE = /^\/[A-Za-z0-9_-]+\.html$/;

function serveStatic(req, res){
  const pathOnly = req.url.split("?")[0];
  let urlPath;
  try {
    urlPath = decodeURIComponent(pathOnly === "/" ? "/index.html" : pathOnly);
  } catch (e) {
    // 壊れたURL(例: %E0%A4%A)でもサーバーが止まらないようにする
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("URLの形式が正しくありません");
  }
  if (!PUBLIC_PAGE.test(urlPath)) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("Not found");
  }
  const filePath = path.join(__dirname, urlPath);
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

// ---- 本のデータの入力チェック ----
// 問題があれば { error: "やさしい理由" } を、なければ { value: 整えた本のデータ } を返す。

function isRealDate(text){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const year = Number(text.slice(0, 4));
  if(year < 1900 || year > 2100) return false;
  const d = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === text;
}

function validateBook(b, index){
  const fallbackLabel = `${index + 1}冊目`;
  if(b === null || typeof b !== "object" || Array.isArray(b)){
    return { error: `${fallbackLabel}のデータの形式が正しくありません。ページを読み込み直してからもう一度お試しください。` };
  }

  // タイトル(必須)
  if(b.title !== undefined && b.title !== null && typeof b.title !== "string"){
    return { error: `${fallbackLabel}のタイトルは文字で入れてください。` };
  }
  const title = (b.title || "").trim();
  if(!title) return { error: `${fallbackLabel}のタイトルが空のようです。タイトルを入れてくださいね。` };
  if(title.length > BOOK_LIMITS.title){
    return { error: `タイトルが長すぎるようです(${title.length}文字)。${BOOK_LIMITS.title}文字以内にしてくださいね。` };
  }
  const label = `「${title.length > 15 ? title.slice(0, 15) + "…" : title}」`;

  // 数値のid
  if(!Number.isSafeInteger(b.id) || b.id < 1){
    return { error: `${label}の管理番号が正しくありません。ページを読み込み直してからもう一度お試しください。` };
  }

  // 著者・メモ・棚(カテゴリ)は空でもよいが、文字であること・長すぎないこと
  const textFields = [
    ["author", "著者", BOOK_LIMITS.author],
    ["memo", "メモ・感想", BOOK_LIMITS.memo],
    ["category", "棚(カテゴリ)", BOOK_LIMITS.category],
  ];
  const texts = {};
  for(const [key, name, max] of textFields){
    const raw = b[key];
    if(raw !== undefined && raw !== null && typeof raw !== "string"){
      return { error: `${label}の${name}は文字で入れてください。` };
    }
    const v = (raw || "").trim();
    if(v.length > max){
      return { error: `${label}の${name}が長すぎるようです(${v.length}文字)。${max}文字以内にしてくださいね。` };
    }
    texts[key] = v;
  }

  // 読んだ日(空ならそのまま。あれば実在する日付)
  let date = "";
  if(b.date !== undefined && b.date !== null && b.date !== ""){
    if(typeof b.date !== "string" || !isRealDate(b.date)){
      return { error: `${label}の読んだ日は、「2026-09-24」のような1900〜2100年の日付で入れてくださいね。` };
    }
    date = b.date;
  }

  // 評価(0〜5の整数)
  let rating = 0;
  if(b.rating !== undefined && b.rating !== null){
    if(!Number.isInteger(b.rating) || b.rating < 0 || b.rating > 5){
      return { error: `${label}の評価は、0〜5の星から選んでくださいね。` };
    }
    rating = b.rating;
  }

  // ページ数(なくてもよい。あれば1以上の整数)
  let pages = null;
  if(b.pages !== undefined && b.pages !== null && b.pages !== ""){
    if(!Number.isInteger(b.pages) || b.pages < 1 || b.pages > BOOK_LIMITS.pagesMax){
      return { error: `${label}のページ数は、1〜${BOOK_LIMITS.pagesMax}の整数で入れてくださいね。` };
    }
    pages = b.pages;
  }

  return {
    value: {
      id: b.id, title, author: texts.author, date, memo: texts.memo,
      rating, category: texts.category, pages,
    },
  };
}

function validateBooks(input){
  if(!Array.isArray(input)){
    return { error: "本のデータの形式が正しくありません。ページを読み込み直してからもう一度お試しください。" };
  }
  if(input.length > MAX_BOOKS){
    return { error: `記録できるのは${MAX_BOOKS}冊までです。` };
  }
  const seen = new Set();
  const books = [];
  for(let i = 0; i < input.length; i++){
    const result = validateBook(input[i], i);
    if(result.error) return { error: result.error };
    if(seen.has(result.value.id)){
      return { error: "同じ管理番号の本が重なっています。ページを読み込み直してからもう一度お試しください。" };
    }
    seen.add(result.value.id);
    books.push(result.value);
  }
  return { books };
}

async function handleSaveBooks(req, res, user){
  const body = await readJsonBody(req, MAX_BOOKS_BODY_BYTES);
  const { books, error } = validateBooks(body);
  if(error) return sendJson(res, 400, { ok: false, error });

  if(user.plan !== "paid" && books.length > FREE_BOOK_LIMIT){
    return sendJson(res, 402, {
      ok: false,
      error: `無料プランは${FREE_BOOK_LIMIT}冊までです。無制限プランへのアップグレードをご検討ください。`,
    });
  }
  try{
    saveBooks(books);
  }catch(e){
    console.error("[本の保存に失敗]", e);
    return sendJson(res, 500, { ok: false, error: "保存中に問題が起きました。しばらくしてからもう一度お試しください。" });
  }
  sendJson(res, 200, { ok: true });
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
  if (typeof password !== "string" || typeof stored !== "string") return false;
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  try {
    const check = crypto.scryptSync(password, salt, 64);
    const original = Buffer.from(hash, "hex");
    if (check.length !== original.length) return false;
    return crypto.timingSafeEqual(check, original);
  } catch (e) {
    return false;
  }
}

function parseCookies(req){
  const header = req.headers.cookie || "";
  const out = {};
  header.split(";").forEach((part) => {
    const idx = part.indexOf("=");
    if (idx === -1) return;
    const name = part.slice(0, idx).trim();
    const raw = part.slice(idx + 1).trim();
    try {
      out[name] = decodeURIComponent(raw);
    } catch (e) {
      // 壊れたCookie(例: %E0%A4%A)はそのまま使わず、無かったことにする
    }
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
    `SELECT users.id, users.username, users.role, users.plan, users.payment_failed_at FROM sessions
     JOIN users ON users.id = sessions.user_id
     WHERE sessions.token = ?`
  ).get(token);
  return row || null;
}

// リクエストの本文を読み込む。上限(maxBytes)を超えたら、読むのをやめて413を返す。
function readBody(req, maxBytes){
  return new Promise((resolve, reject) => {
    const tooLarge = () => new HttpError(413, "送られたデータが大きすぎます。内容を短くしてからもう一度お試しください。");
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > maxBytes) {
      req.resume(); // 残りは読み捨てる
      return reject(tooLarge());
    }
    const chunks = [];
    let size = 0;
    let finished = false;
    req.on("data", (chunk) => {
      if (finished) return;
      size += chunk.length;
      if (size > maxBytes) {
        finished = true;
        chunks.length = 0;
        return reject(tooLarge());
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (finished) return;
      finished = true;
      resolve(Buffer.concat(chunks));
    });
    req.on("error", () => {
      if (finished) return;
      finished = true;
      reject(new HttpError(400, "通信中に問題が起きました。もう一度お試しください。"));
    });
  });
}

// JSONの本文を読む。空の本文は {} 、壊れたJSONは400にする。
async function readJsonBody(req, maxBytes = MAX_AUTH_BODY_BYTES){
  const buf = await readBody(req, maxBytes);
  const text = buf.toString("utf8");
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new HttpError(400, BAD_REQUEST_ERROR);
  }
}

// 本文が { ... } の形(オブジェクト)であることを確かめる。null・配列・数字などは弾く。
function requireObject(body){
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, BAD_REQUEST_ERROR);
  }
  return body;
}

// ユーザー名・パスワードの入力チェック。問題があれば { error }、なければ { value } を返す。
function checkUsername(raw){
  if (typeof raw !== "string" || !raw.trim()) return { error: "ユーザー名を入力してください" };
  const v = raw.trim();
  if (v.length < USERNAME_MIN) return { error: `ユーザー名は${USERNAME_MIN}文字以上にしてください` };
  if (v.length > USERNAME_MAX) return { error: `ユーザー名は${USERNAME_MAX}文字以内にしてください` };
  if (/[\u0000-\u001f\u007f]/.test(v)) return { error: "ユーザー名に使えない文字が含まれています" };
  return { value: v };
}

function checkNewPassword(raw){
  if (typeof raw !== "string" || raw === "") return { error: "パスワードを入力してください" };
  if (raw.length < PASSWORD_MIN) return { error: `パスワードは${PASSWORD_MIN}文字以上にしてください` };
  if (raw.length > PASSWORD_MAX) return { error: `パスワードは${PASSWORD_MAX}文字以内にしてください` };
  return { value: raw };
}

function sendJson(res, status, obj){
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

async function handleSignup(req, res){
  const body = requireObject(await readJsonBody(req));
  const u = checkUsername(body.username);
  if (u.error) return sendJson(res, 400, { ok: false, error: u.error });
  const p = checkNewPassword(body.password);
  if (p.error) return sendJson(res, 400, { ok: false, error: p.error });
  const username = u.value;
  const password = p.value;

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
  logAudit(username, "signup", `role=${role}`);
  res.end(JSON.stringify({ ok: true, username, role, plan: "free" }));
}

async function handleLogin(req, res){
  const body = requireObject(await readJsonBody(req));
  const username = typeof body.username === "string" ? body.username.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!username) return sendJson(res, 400, { ok: false, error: "ユーザー名を入力してください" });
  if (!password) return sendJson(res, 400, { ok: false, error: "パスワードを入力してください" });
  if (username.length > USERNAME_MAX || password.length > PASSWORD_MAX) {
    // 長すぎる入力は、記録もパスワード計算もせずに「違います」と返す
    return sendJson(res, 401, { ok: false, error: "ユーザー名またはパスワードが違います" });
  }

  const lockedMinutes = checkLoginLock(username);
  if(lockedMinutes !== null){
    logAudit(username, "login_blocked", `失敗が続いたため一時ロック中(残り約${lockedMinutes}分)`);
    return sendJson(res, 429, { ok: false, error: `ログイン試行が多すぎます。約${lockedMinutes}分後にもう一度お試しください。` });
  }

  const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username);
  if (!user || !verifyPassword(password, user.password_hash)) {
    recordLoginFailure(username);
    logAudit(username, "login_failed");
    return sendJson(res, 401, { ok: false, error: "ユーザー名またはパスワードが違います" });
  }
  clearLoginFailures(username);
  logAudit(username, "login_success");
  const token = createSession(user.id);
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Set-Cookie": `session=${token}; HttpOnly; Path=/; SameSite=Lax`,
  });
  res.end(JSON.stringify({ ok: true, username: user.username, role: user.role, plan: user.plan, payment_failed_at: user.payment_failed_at }));
}

function handleLogout(req, res){
  const cookies = parseCookies(req);
  if (cookies.session) {
    const session = getSessionUser(req);
    if(session) logAudit(session.username, "logout");
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
  const body = requireObject(await readJsonBody(req));
  if (typeof body.username !== "string" || !body.username.trim()) {
    return sendJson(res, 400, { ok: false, error: "ユーザー名を入力してください" });
  }
  const username = body.username.trim();
  if (username.length > USERNAME_MAX) return sendJson(res, 200, { ok: true }); // 存在しない名前と同じ返事
  const user = db.prepare("SELECT id FROM users WHERE username = ?").get(username);
  if (!user) {
    // ユーザーの有無を外部に漏らさないため、常に同じ返事にする
    return sendJson(res, 200, { ok: true });
  }
  const token = crypto.randomBytes(20).toString("hex");
  const expires = new Date(Date.now() + 30 * 60 * 1000).toISOString(); // 30分
  db.prepare("UPDATE users SET reset_token = ?, reset_token_expires = ? WHERE id = ?")
    .run(token, expires, user.id);
  // 本来はメール送信。トークンは絶対にレスポンスに含めない(誰でも取得できてしまうため)。
  // 開発中の動作確認は、サーバーのログに出力したものを見て行う。
  console.log(`[パスワード再発行] ${username} 用のトークン: ${token}`);
  logAudit(username, "password_reset_requested");
  sendJson(res, 200, { ok: true });
}

async function handleCompleteReset(req, res){
  const body = requireObject(await readJsonBody(req));
  const p = checkNewPassword(body.newPassword);
  if (p.error) return sendJson(res, 400, { ok: false, error: p.error });
  const newPassword = p.value;
  const token = typeof body.token === "string" ? body.token : "";
  if (!token || token.length > 200) return sendJson(res, 400, { ok: false, error: "トークンが無効か、期限切れです" });

  const user = db.prepare(
    "SELECT * FROM users WHERE reset_token = ? AND reset_token_expires > ?"
  ).get(token, new Date().toISOString());
  if (!user) return sendJson(res, 400, { ok: false, error: "トークンが無効か、期限切れです" });

  db.prepare("UPDATE users SET password_hash = ?, reset_token = NULL, reset_token_expires = NULL WHERE id = ?")
    .run(hashPassword(newPassword), user.id);
  logAudit(user.username, "password_reset_completed");
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
    console.error("[決済ページの作成に失敗]", e);
    sendJson(res, 500, { ok: false, error: "決済ページを開けませんでした。しばらくしてからもう一度お試しください。" });
  }
}

async function handleConfirmCheckout(req, res, user){
  if(!stripe) return sendJson(res, 500, { ok: false, error: "決済が設定されていません（STRIPE_SECRET_KEYが未設定）" });
  const url = new URL(req.url, "http://localhost");
  const sessionId = url.searchParams.get("session_id");
  if(!sessionId) return sendJson(res, 400, { ok: false, error: "お支払いの確認に必要な情報が見つかりませんでした" });
  if(sessionId.length > 200 || !/^cs_[A-Za-z0-9_]+$/.test(sessionId)){
    return sendJson(res, 400, { ok: false, error: "お支払いの確認に必要な情報の形式が正しくありません" });
  }
  try{
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if(session.client_reference_id !== String(user.id) || session.payment_status !== "paid"){
      return sendJson(res, 400, { ok: false, error: "支払いが確認できませんでした" });
    }
    db.prepare("UPDATE users SET plan = 'paid', stripe_customer_id = ? WHERE id = ?")
      .run(session.customer, user.id);
    logAudit(user.username, "plan_upgraded", "checkout confirm");
    sendJson(res, 200, { ok: true, plan: "paid" });
  }catch(e){
    console.error("[お支払いの確認に失敗]", e);
    sendJson(res, 500, { ok: false, error: "お支払いを確認できませんでした。しばらくしてからもう一度お試しください。" });
  }
}

function readRawBody(req){
  return readBody(req, MAX_WEBHOOK_BODY_BYTES);
}

// Stripeからの通知(Webhook)。課金成功・失敗・解約に応じてユーザーの状態を自動で切り替える。
async function handleStripeWebhook(req, res){
  if(!stripe || !process.env.STRIPE_WEBHOOK_SECRET){
    res.writeHead(500);
    return res.end("webhookが設定されていません");
  }
  const rawBody = await readRawBody(req);
  let event;
  try{
    event = stripe.webhooks.constructEvent(rawBody, req.headers["stripe-signature"], process.env.STRIPE_WEBHOOK_SECRET);
  }catch(e){
    res.writeHead(400);
    return res.end(`Webhook Error: ${e.message}`);
  }

  const obj = (event && event.data && event.data.object) || {};
  const byCustomer = db.prepare("SELECT username FROM users WHERE stripe_customer_id = ?").get(obj.customer);
  const username = byCustomer ? byCustomer.username : null;

  if(event.type === "invoice.payment_failed"){
    // 支払い失敗: すぐには止めず、猶予として記録だけする(Stripeが自動で再試行する)
    db.prepare("UPDATE users SET payment_failed_at = ? WHERE stripe_customer_id = ?")
      .run(new Date().toISOString(), obj.customer);
    logAudit(username, "payment_failed");
  }
  if(event.type === "invoice.payment_succeeded"){
    db.prepare("UPDATE users SET plan = 'paid', payment_failed_at = NULL WHERE stripe_customer_id = ?")
      .run(obj.customer);
    logAudit(username, "payment_succeeded");
  }
  if(event.type === "customer.subscription.deleted"){
    // 解約完了: 無料プランに戻す
    db.prepare("UPDATE users SET plan = 'free', payment_failed_at = NULL WHERE stripe_customer_id = ?")
      .run(obj.customer);
    logAudit(username, "subscription_cancelled");
  }
  sendJson(res, 200, { received: true });
}

async function handleBillingPortal(req, res, user){
  if(!stripe) return sendJson(res, 500, { ok: false, error: "決済が設定されていません（STRIPE_SECRET_KEYが未設定）" });
  const row = db.prepare("SELECT stripe_customer_id FROM users WHERE id = ?").get(user.id);
  if(!row || !row.stripe_customer_id){
    return sendJson(res, 400, { ok: false, error: "有料プランの契約が見つかりません" });
  }
  try{
    const session = await stripe.billingPortal.sessions.create({
      customer: row.stripe_customer_id,
      return_url: `${originOf(req)}/`,
    });
    sendJson(res, 200, { ok: true, url: session.url });
  }catch(e){
    console.error("[請求ポータルの作成に失敗]", e);
    sendJson(res, 500, { ok: false, error: "ページを開けませんでした。しばらくしてからもう一度お試しください。" });
  }
}

// ---- AIによるおすすめ（有料プラン限定・月20回まで） ----

function currentMonthKey(){
  return new Date().toISOString().slice(0, 7); // "2026-08"
}

async function callClaude(prompt){
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 500,
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(30000), // 30秒たっても返事がなければあきらめる
  });
  if(!res.ok){
    const errBody = await res.text();
    throw new Error(`Claude APIエラー: ${res.status} ${errBody}`);
  }
  const data = await res.json();
  const text = data && Array.isArray(data.content) && data.content[0] && data.content[0].text;
  if(typeof text !== "string" || !text) throw new Error("Claude APIの返事が想定外の形でした");
  return text;
}

async function handleRecommend(req, res, user){
  if(user.plan !== "paid"){
    return sendJson(res, 403, { ok: false, error: "この機能は有料プランでご利用いただけます" });
  }
  if(!ANTHROPIC_API_KEY){
    return sendJson(res, 500, { ok: false, error: "AI機能が設定されていません（ANTHROPIC_API_KEYが未設定）" });
  }

  const row = db.prepare("SELECT recommend_count, recommend_count_month FROM users WHERE id = ?").get(user.id);
  const month = currentMonthKey();
  const usedThisMonth = row.recommend_count_month === month ? row.recommend_count : 0;
  if(usedThisMonth >= RECOMMEND_MONTHLY_LIMIT){
    return sendJson(res, 429, { ok: false, error: `今月の上限(${RECOMMEND_MONTHLY_LIMIT}回)に達しました。来月またお試しください。` });
  }

  const books = loadBooks();
  if(books.length === 0){
    return sendJson(res, 400, { ok: false, error: "本棚に本がまだありません" });
  }
  const shelf = books.map(b => `・${b.title}（${b.author || "著者不明"}／${b.category || "未分類"}／評価${b.rating || 0}）`).join("\n");
  const prompt = `以下は、ある人の読書記録です。\n${shelf}\n\nこの読書傾向をふまえて、次に読むと良さそうな本を3冊、理由も添えて日本語で提案してください。簡潔にお願いします。`;

  try{
    const text = await callClaude(prompt);
    db.prepare("UPDATE users SET recommend_count = ?, recommend_count_month = ? WHERE id = ?")
      .run(usedThisMonth + 1, month, user.id);
    sendJson(res, 200, { ok: true, text, usedThisMonth: usedThisMonth + 1, limit: RECOMMEND_MONTHLY_LIMIT });
  }catch(e){
    console.error("[AIおすすめの取得に失敗]", e);
    sendJson(res, 500, { ok: false, error: "おすすめを取得できませんでした。しばらくしてからもう一度お試しください。" });
  }
}

function handleGetAuditLog(req, res, user){
  if(user.role !== "admin"){
    return sendJson(res, 403, { ok: false, error: "監査ログは管理者(admin)だけが見られます" });
  }
  const rows = db.prepare("SELECT username, action, detail, created_at FROM audit_log ORDER BY id DESC LIMIT 200").all();
  sendJson(res, 200, { ok: true, logs: rows });
}

function handleGetCustomers(req, res, user){
  if(user.role !== "admin"){
    return sendJson(res, 403, { ok: false, error: "利用者一覧は管理者(admin)だけが見られます" });
  }
  const rows = db.prepare(
    "SELECT username, role, plan, payment_failed_at, created_at FROM users ORDER BY id"
  ).all();
  sendJson(res, 200, { ok: true, customers: rows });
}

function requireLogin(req, res){
  const user = getSessionUser(req);
  if (!user) {
    sendJson(res, 401, { ok: false, error: "ログインが必要です" });
    return null;
  }
  return user;
}

// どこで想定外のエラーが起きても、サーバー全体を止めずに、利用者へやさしい返事を返す。
function handleRouteError(err, req, res){
  if (res.headersSent || res.writableEnded) {
    // すでに返事を送り始めている場合は、接続を閉じるだけにする
    console.error(`[応答の途中でエラー] ${req.method} ${req.url}`, err);
    try { res.end(); } catch (e) { /* 何もしない */ }
    return;
  }
  if (err instanceof HttpError) {
    return sendJson(res, err.status, { ok: false, error: err.message });
  }
  console.error(`[想定外のエラー] ${req.method} ${req.url}`, err);
  sendJson(res, 500, { ok: false, error: GENERIC_SERVER_ERROR });
}

function route(req, res) {
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
  if (req.url === "/api/stripe/webhook" && req.method === "POST") {
    return handleStripeWebhook(req, res);
  }
  if (req.url === "/api/billing-portal" && req.method === "POST") {
    const user = requireLogin(req, res);
    if (!user) return;
    return handleBillingPortal(req, res, user);
  }
  if (req.url === "/api/recommend" && req.method === "POST") {
    const user = requireLogin(req, res);
    if (!user) return;
    return handleRecommend(req, res, user);
  }
  if (req.url === "/api/audit-log" && req.method === "GET") {
    const user = requireLogin(req, res);
    if (!user) return;
    return handleGetAuditLog(req, res, user);
  }
  if (req.url === "/api/customers" && req.method === "GET") {
    const user = requireLogin(req, res);
    if (!user) return;
    return handleGetCustomers(req, res, user);
  }
  return serveStatic(req, res);
}

const server = http.createServer((req, res) => {
  // 同期のエラーも、async関数のエラー(Promiseの失敗)も、ここで受け止める
  Promise.resolve()
    .then(() => route(req, res))
    .catch((err) => handleRouteError(err, req, res));
});

if (require.main === module) {
  // 万一ここまで届いた想定外のエラーでも、サーバーを落とさずに記録だけ残す
  process.on("uncaughtException", (err) => console.error("[想定外のエラー(継続します)]", err));
  process.on("unhandledRejection", (err) => console.error("[想定外の失敗(継続します)]", err));
  server.listen(PORT, () => {
    console.log(`読書記録アプリ起動中: http://localhost:${PORT}`);
  });
}

module.exports = server;

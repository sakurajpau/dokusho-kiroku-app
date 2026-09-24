const test = require("node:test");
const assert = require("node:assert/strict");
process.env.DB_PATH = ":memory:";
process.env.ADMIN_USERNAME = "test_admin_user";
const server = require("../server.js");

function withServer(run) {
  return new Promise((resolve, reject) => {
    server.listen(0, async () => {
      const port = server.address().port;
      try {
        await run(port);
        resolve();
      } catch (err) {
        reject(err);
      } finally {
        server.close();
      }
    });
  });
}

async function signupAndGetCookie(port, username) {
  const res = await fetch(`http://localhost:${port}/api/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password: "password123" }),
  });
  const cookie = res.headers.get("set-cookie");
  return cookie.split(";")[0]; // "session=xxxx" の部分だけ取り出す
}

test("GET /api/books はログインしていないと401を返す", async () => {
  await withServer(async (port) => {
    const res = await fetch(`http://localhost:${port}/api/books`);
    assert.equal(res.status, 401);
  });
});

test("マイグレーションで追加した pages 列が保存・取得できる", async () => {
  await withServer(async (port) => {
    const cookie = await signupAndGetCookie(port, "test_admin_user");
    const book = {
      id: 999, title: "テスト本", author: "テスト著者",
      date: "2026-01-01", memo: "", rating: 3, category: "小説", pages: 250,
    };
    await fetch(`http://localhost:${port}/api/books`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify([book]),
    });
    const res = await fetch(`http://localhost:${port}/api/books`, {
      headers: { Cookie: cookie },
    });
    const data = await res.json();
    assert.equal(data.length, 1);
    assert.equal(data[0].pages, 250);
  });
});

test("GET /api/books はログインしていれば本のリスト(配列)を返す", async () => {
  await withServer(async (port) => {
    const cookie = await signupAndGetCookie(port, "test_list_user");
    const res = await fetch(`http://localhost:${port}/api/books`, {
      headers: { Cookie: cookie },
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data), "レスポンスは配列であるべき");
  });
});

test("GET / はトップページ(index.html)を返す", async () => {
  await withServer(async (port) => {
    const res = await fetch(`http://localhost:${port}/`);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes("<html"), "index.htmlの中身が返るべき");
  });
});

test("存在しないパスは404を返す", async () => {
  await withServer(async (port) => {
    const res = await fetch(`http://localhost:${port}/no-such-page`);
    assert.equal(res.status, 404);
  });
});

// ---- 入力チェック(空欄・変な値・長すぎる入力でもサーバーが落ちないこと) ----
const http = require("node:http");

// fetchでは作れない壊れたURLや、本文を細切れに送る場合に使う低レベルのリクエスト
function rawRequest(port, { method = "GET", path = "/", headers = {}, chunks = [] } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      const parts = [];
      res.on("data", (c) => parts.push(c));
      res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(parts).toString("utf8") }));
    });
    req.on("error", reject);
    (async () => {
      for (const c of chunks) {
        req.write(c);
        await new Promise((r) => setTimeout(r, 15)); // 別々のかたまりとして届くように少し待つ
      }
      req.end();
    })();
  });
}

async function postJson(port, path, body, cookie) {
  const headers = { "Content-Type": "application/json" };
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(`http://localhost:${port}${path}`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch (e) { /* JSONでない返事 */ }
  return { status: res.status, data };
}

async function adminCookie(port) {
  const login = await fetch(`http://localhost:${port}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "test_admin_user", password: "password123" }),
  });
  if (login.status === 200) return login.headers.get("set-cookie").split(";")[0];
  return signupAndGetCookie(port, "test_admin_user");
}

async function assertAlive(port) {
  const res = await fetch(`http://localhost:${port}/health`);
  assert.equal(res.status, 200, "エラーのあともサーバーが動いているべき");
}

test("壊れたURLやCookieでもサーバーが落ちず、公開してはいけないファイルは返さない", async () => {
  await withServer(async (port) => {
    assert.equal((await rawRequest(port, { path: "/%E0%A4%A" })).status, 400);
    assert.equal((await rawRequest(port, { path: "/%00" })).status, 404);
    for (const p of ["/data.db", "/server.js", "/books.json", "/package.json", "/.git/config", "/db/connection.js", "/../server.js", "/%2e%2e/server.js"]) {
      assert.equal((await rawRequest(port, { path: p })).status, 404, `${p} は返さない`);
    }
    assert.equal((await rawRequest(port, { path: "/terms.html" })).status, 200);

    const me = await rawRequest(port, { path: "/api/me", headers: { Cookie: "session=%E0%A4%A" } });
    assert.equal(me.status, 200);
    assert.equal(JSON.parse(me.text).user, null);
    const books = await rawRequest(port, { path: "/api/books", headers: { Cookie: "session=%E0%A4%A; x=%" } });
    assert.equal(books.status, 401);
    await assertAlive(port);
  });
});

test("登録・ログイン・パスワード再発行に変な値が来ても落ちず、やさしい理由を返す", async () => {
  await withServer(async (port) => {
    const weirdBodies = [
      "null", "[]", "123", '"abc"', "true", "not json{",
      { username: 12345, password: 12345678 },
      { username: { a: 1 }, password: ["x"] },
      { username: null, password: null },
      { username: "", password: "" },
      { username: "   ", password: "        " },
      { username: "ab", password: "short" },
      { username: "a".repeat(51), password: "password123" },
      { username: "valid_user_x", password: "p".repeat(201) },
      { username: "bad\u0000name", password: "password123" },
      { token: 123, newPassword: 456 },
      { token: "x".repeat(500), newPassword: "password123" },
    ];
    const endpoints = ["/api/signup", "/api/login", "/api/password-reset/request", "/api/password-reset/complete"];
    for (const path of endpoints) {
      for (const body of weirdBodies) {
        const { status, data } = await postJson(port, path, body);
        const label = `${path} ${JSON.stringify(body).slice(0, 50)}`;
        assert.ok(status >= 400 && status < 500 || (status === 200 && path.includes("request")), `${label} → ${status}`);
        if (status >= 400) {
          assert.equal(data.ok, false, label);
          assert.ok(typeof data.error === "string" && data.error.length > 0, `${label} に理由がある`);
        }
      }
    }
    const short = await postJson(port, "/api/signup", { username: "ab", password: "password123" });
    assert.match(short.data.error, /ユーザー名は3文字以上/);
    const shortPw = await postJson(port, "/api/signup", { username: "valid_user_y", password: "short" });
    assert.match(shortPw.data.error, /パスワードは8文字以上/);
    const numeric = await postJson(port, "/api/signup", { username: 12345, password: 12345678 });
    assert.match(numeric.data.error, /ユーザー名/);
    await assertAlive(port);
  });
});

test("大きすぎるデータは413で断り、そのあともサーバーは動く", async () => {
  await withServer(async (port) => {
    const big = await postJson(port, "/api/signup", { username: "a".repeat(20000), password: "password123" });
    assert.equal(big.status, 413);
    assert.match(big.data.error, /大きすぎ/);

    const cookie = await adminCookie(port);
    const huge = await postJson(port, "/api/books", "[" + '{"id":1,"title":"x"},'.repeat(700000) + '{"id":2,"title":"y"}]', cookie);
    assert.equal(huge.status, 413);
    await assertAlive(port);
  });
});

test("本の保存: 変な値は400で理由を返し、正しい値は保存できる", async () => {
  await withServer(async (port) => {
    const cookie = await adminCookie(port);
    const ok = { id: 1, title: "テスト", author: "著者", date: "2026-09-24", memo: "", rating: 3, category: "小説" };
    const cases = [
      ["配列ではない", {}, /形式/],
      ["nullが混ざる", [null], /形式/],
      ["数字が混ざる", [123], /形式/],
      ["タイトルが空", [{ ...ok, title: "" }], /タイトル/],
      ["タイトルが空白だけ", [{ ...ok, title: "   " }], /タイトル/],
      ["タイトルが数字", [{ ...ok, title: 123 }], /タイトル/],
      ["タイトルが長すぎる", [{ ...ok, title: "あ".repeat(201) }], /長すぎ/],
      ["著者が長すぎる", [{ ...ok, author: "あ".repeat(101) }], /著者.*長すぎ/],
      ["メモが長すぎる", [{ ...ok, memo: "あ".repeat(5001) }], /メモ.*長すぎ/],
      ["メモが配列", [{ ...ok, memo: ["a"] }], /メモ/],
      ["棚が長すぎる", [{ ...ok, category: "あ".repeat(31) }], /棚.*長すぎ/],
      ["評価が範囲外", [{ ...ok, rating: 99 }], /評価/],
      ["評価がマイナス", [{ ...ok, rating: -1 }], /評価/],
      ["評価が小数", [{ ...ok, rating: 2.5 }], /評価/],
      ["評価が文字", [{ ...ok, rating: "3" }], /評価/],
      ["日付が存在しない", [{ ...ok, date: "2026-13-45" }], /日付/],
      ["日付が文字", [{ ...ok, date: "きのう" }], /日付/],
      ["日付が遠すぎる", [{ ...ok, date: "9999-01-01" }], /日付/],
      ["idが文字", [{ ...ok, id: "abc" }], /管理番号/],
      ["idが小数", [{ ...ok, id: 1.5 }], /管理番号/],
      ["idが重複", [ok, { ...ok }], /重な/],
      ["ページ数がマイナス", [{ ...ok, pages: -5 }], /ページ数/],
      ["ページ数が小数", [{ ...ok, pages: 1.5 }], /ページ数/],
      ["冊数が多すぎる", Array.from({ length: 1001 }, (_, i) => ({ ...ok, id: i + 1 })), /1000冊/],
    ];
    for (const [name, body, pattern] of cases) {
      const { status, data } = await postJson(port, "/api/books", body, cookie);
      assert.equal(status, 400, `${name} → ${status}`);
      assert.equal(data.ok, false, name);
      assert.match(data.error, pattern, name);
    }
    // 断られたあとも、保存済みのデータは壊れていない
    const before = await (await fetch(`http://localhost:${port}/api/books`, { headers: { Cookie: cookie } })).json();
    assert.ok(Array.isArray(before));

    // 正しい値は保存できる(前後の空白は取り除かれ、著者・メモは空でもよい)
    const saved = await postJson(port, "/api/books", [{ id: 5, title: "  空白つき  ", rating: 5, date: "2026-09-24" }], cookie);
    assert.equal(saved.status, 200);
    const after = await (await fetch(`http://localhost:${port}/api/books`, { headers: { Cookie: cookie } })).json();
    assert.equal(after.length, 1);
    assert.equal(after[0].title, "空白つき");
    assert.equal(after[0].author, "");
    assert.equal(after[0].rating, 5);

    // 無料プランの上限(10冊)は、入力チェックのあとで今までどおり働く
    const eleven = Array.from({ length: 11 }, (_, i) => ({ ...ok, id: i + 1 }));
    assert.equal((await postJson(port, "/api/books", eleven, cookie)).status, 402);
    await assertAlive(port);
  });
});

test("日本語が細切れに届いても、文字化けせずに保存できる", async () => {
  await withServer(async (port) => {
    const cookie = await adminCookie(port);
    const body = Buffer.from(JSON.stringify([{ id: 7, title: "あいうえお夜と霧", rating: 4, date: "2026-09-24" }]), "utf8");
    const cut = body.indexOf(Buffer.from("あ")) + 1; // 「あ」の3バイトの途中で分ける
    const res = await rawRequest(port, {
      method: "POST",
      path: "/api/books",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      chunks: [body.subarray(0, cut), body.subarray(cut)],
    });
    assert.equal(res.status, 200);
    const list = await (await fetch(`http://localhost:${port}/api/books`, { headers: { Cookie: cookie } })).json();
    assert.equal(list[0].title, "あいうえお夜と霧");
  });
});

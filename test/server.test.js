const test = require("node:test");
const assert = require("node:assert/strict");
process.env.DB_PATH = ":memory:";
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

// 注意: このテストが本ファイルで最初のサインアップになるため、
// このユーザーが自動的にadmin(編集可)になる。編集操作(POST)を含む
// テストは、必ずこのテストより先に置くこと。
test("マイグレーションで追加した pages 列が保存・取得できる", async () => {
  await withServer(async (port) => {
    const cookie = await signupAndGetCookie(port, "test_pages_admin");
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

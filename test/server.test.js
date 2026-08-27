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

test("GET /api/books は本のリスト(配列)を返す", async () => {
  await withServer(async (port) => {
    const res = await fetch(`http://localhost:${port}/api/books`);
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

test("マイグレーションで追加した pages 列が保存・取得できる", async () => {
  await withServer(async (port) => {
    const book = {
      id: 999, title: "テスト本", author: "テスト著者",
      date: "2026-01-01", memo: "", rating: 3, category: "小説", pages: 250,
    };
    await fetch(`http://localhost:${port}/api/books`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([book]),
    });
    const res = await fetch(`http://localhost:${port}/api/books`);
    const data = await res.json();
    assert.equal(data.length, 1);
    assert.equal(data[0].pages, 250);
  });
});

test("マイグレーションで追加した reading_minutes 列が保存・取得できる", async () => {
  await withServer(async (port) => {
    const book = {
      id: 998, title: "テスト本2", author: "テスト著者",
      date: "2026-01-01", memo: "", rating: 3, category: "小説", reading_minutes: 185,
    };
    await fetch(`http://localhost:${port}/api/books`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([book]),
    });
    const res = await fetch(`http://localhost:${port}/api/books`);
    const data = await res.json();
    assert.equal(data.length, 1);
    assert.equal(data[0].reading_minutes, 185);
  });
});

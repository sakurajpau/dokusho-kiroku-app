const test = require("node:test");
const assert = require("node:assert/strict");
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

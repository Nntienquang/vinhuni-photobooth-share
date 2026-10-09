import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import test from "node:test";
import ts from "typescript";
import { renderToStaticMarkup } from "react-dom/server";

// Compile real source in memory; replace only external storage and framework boundaries.
const require = createRequire(import.meta.url);
const dataModule = (source) => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const blobModule = dataModule("export const put = (...args) => globalThis.__blob.put(...args); export const list = (...args) => globalThis.__blob.list(...args);");
const clientModule = dataModule("export const generateClientTokenFromReadWriteToken = (...args) => globalThis.__blob.authorize(...args);");
function compile(path, replacements = {}) {
  let source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replace('import "server-only";', "");
  for (const [from, to] of Object.entries({ "@vercel/blob": blobModule, "@vercel/blob/client": clientModule, ...replacements })) {
    source = source.replaceAll(`"${from}"`, JSON.stringify(to));
  }
  const output = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX,
  }, fileName: path }).outputText.replaceAll('"react/jsx-runtime"', JSON.stringify(pathToFileURL(require.resolve("react/jsx-runtime")).href));
  return dataModule(output);
}
const sharesModule = compile("lib/shares.ts");
const { findShare, shareUrl, SHARE_ID_PATTERN } = await import(sharesModule);
const { POST } = await import(compile("app/api/upload/route.ts", { "@/lib/shares": sharesModule }));
const { GET: download } = await import(compile("app/api/download/[shareId]/route.ts", { "@/lib/shares": sharesModule }));
const saverModule = compile("app/p/[shareId]/save-photo.ts");
const { createPhotoSaver } = await import(saverModule);
const actionsModule = compile("app/p/[shareId]/photo-actions.tsx", {
  "./save-photo": saverModule,
  "react": pathToFileURL(require.resolve("react")).href,
});
const { default: SharePage } = await import(compile("app/p/[shareId]/page.tsx", {
  "./photo-actions": actionsModule,
  "@/lib/shares": sharesModule,
  "next/navigation": dataModule('export function notFound() { throw new Error("NOT_FOUND"); }'),
}));
const key = randomBytes(32).toString("hex");
process.env.UPLOAD_API_KEY = key;
process.env.NODE_ENV = "production";
const store = new Map();
const grants = new Map();
globalThis.__blob = {
  async authorize(options) {
    const token = randomBytes(32).toString("hex");
    grants.set(token, options);
    return token;
  },
  async put(pathname, file, options) {
    const grant = grants.get(options.token);
    assert.ok(grant);
    assert.equal(grant.pathname, pathname);
    assert.equal(grant.addRandomSuffix, false);
    assert.equal(grant.allowOverwrite, false);
    assert.deepEqual(grant.allowedContentTypes, [file.type]);
    assert.equal(grant.maximumSizeInBytes, file.size);
    assert.ok(grant.validUntil > Date.now());
    assert.ok(grant.validUntil <= Date.now() + 10 * 60 * 1000);
    assert.equal(options.access, "public");
    assert.equal(options.contentType, file.type);
    const item = { pathname, url: `https://example.public.blob.vercel-storage.com/${pathname}`, bytes: Buffer.from(await file.arrayBuffer()) };
    store.set(pathname, item);
    return item;
  },
  async list({ prefix }) { return { blobs: [...store.values()].filter(b => b.pathname.startsWith(prefix)), hasMore: false }; },
};
function request(file, authorization = `Bearer ${key}`) {
  const metadata = file instanceof File ? { contentType: file.type, size: file.size } : file;
  return new Request("http://localhost:3000/api/upload", { method: "POST", headers: { "Content-Type": "application/json", ...(authorization === null ? {} : { Authorization: authorization }) }, body: JSON.stringify(metadata ?? {}) });
}

test("rejects absent, malformed, wrong, and unconfigured credentials", async () => {
  for (const header of [null, "Basic test", "Bearer", "Bearer wrong", `Bearer ${key} extra`]) {
    assert.equal((await POST(request(undefined, header))).status, 401);
  }
  delete process.env.UPLOAD_API_KEY;
  assert.equal((await POST(request())).status, 401);
  process.env.UPLOAD_API_KEY = key;
});
test("rejects missing, empty, unsupported, and malformed input", async () => {
  for (const [file, status] of [[undefined, 400], ["text", 400], [new File([], "empty.jpg", { type: "image/jpeg" }), 400], [new File(["text"], "text.txt", { type: "text/plain" }), 415]]) {
    assert.equal((await POST(request(file))).status, status);
  }
  const response = await POST(new Request("http://localhost/api/upload", { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: "bad" }));
  assert.equal(response.status, 400);
  for (const metadata of [null, [], { size: -1 }, { size: 1.5 }, { size: "10" }]) {
    assert.equal((await POST(request(metadata))).status, 400);
  }
  const multipart = request();
  multipart.headers.set("Content-Type", "multipart/form-data; boundary=old");
  assert.equal((await POST(multipart)).status, 400);
});
test("rejects oversized files with and without Content-Length", async () => {
  const req = request(new File([new Uint8Array(20 * 1024 * 1024 + 1)], "big.jpg", { type: "image/jpeg" }));
  assert.equal((await POST(req)).status, 413);
  const declared = request();
  declared.headers.set("Content-Length", String(22 * 1024 * 1024));
  assert.equal((await POST(declared)).status, 413);
  const streamed = request(new File([new Uint8Array(21 * 1024 * 1024)], "big.png", { type: "image/png" }));
  assert.equal((await POST(streamed)).status, 413);
  const largeMetadata = new Request("http://localhost/api/upload", { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ padding: "x".repeat(4097) }) });
  assert.equal((await POST(largeMetadata)).status, 413);
});
test("JPEG/PNG uploads preserve bytes and render the same original download URL", async () => {
  // Tiny image fixtures; no real customer images or credentials.
  const fixtures = [
    ["image/png", "png", "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ZkAAAAASUVORK5CYII="],
    ["image/jpeg", "jpg", "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJgA/9k="],
  ];
  for (const [mime, extension, base64] of fixtures) {
    const bytes = Buffer.from(base64, "base64");
    const file = new File([bytes], "ignored-name", { type: mime });
    const response = await POST(request(file));
    assert.equal(response.status, 201);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    const grant = await response.json();
    assert.equal(grant.imageUrl, undefined);
    const blob = await globalThis.__blob.put(grant.pathname, file, { token: grant.clientToken, access: "public", contentType: mime });
    const result = { shareId: grant.shareId, shareUrl: grant.shareUrl, imageUrl: blob.url };
    assert.deepEqual(Object.keys(result).sort(), ["imageUrl", "shareId", "shareUrl"]);
    assert.match(result.shareId, SHARE_ID_PATTERN);
    assert.equal(result.shareUrl, `https://vinhuni-photobooth-share.vercel.app/p/${result.shareId}`);
    const stored = store.get(`shares/${result.shareId}/final.${extension}`);
    assert.deepEqual(stored.bytes, bytes);
    assert.equal(result.imageUrl, stored.url);
    assert.equal((await findShare(result.shareId)).url, stored.url);
    const html = renderToStaticMarkup(await SharePage({ params: Promise.resolve({ shareId: result.shareId }) }));
    assert.ok(html.includes(`src="${stored.url}"`));
    assert.ok(html.includes(`href="/api/download/${result.shareId}"`));
    assert.ok(!html.includes(`<a class="download" href="${stored.url}"`));
    assert.ok(!html.includes('target="_blank"'));
    assert.ok(html.includes("Trên iPhone: chọn LƯU VÀO ẢNH, sau đó chọn Lưu hình ảnh trong bảng chia sẻ."));
    assert.ok(html.includes('download=""'));
    assert.ok(html.includes("TẢI FILE GỐC"));
    assert.ok(html.includes("LƯU VÀO ẢNH"));
    assert.ok(!html.includes(key));
  }
});
test("download streams identical JPEG/PNG bytes with attachment headers", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const extension of ["jpg", "png"]) {
      const item = [...store.values()].find(item => item.pathname.endsWith(`.${extension}`));
      const shareId = item.pathname.split("/")[1];
      const body = new ReadableStream({ start(controller) {
        controller.enqueue(item.bytes.subarray(0, 10));
        controller.enqueue(item.bytes.subarray(10));
        controller.close();
      } });
      globalThis.fetch = async (url, options) => {
        assert.equal(url, item.url);
        assert.equal(options.cache, "no-store");
        return new Response(body);
      };
      const response = await download(new Request("https://example.com"), { params: Promise.resolve({ shareId }) });
      assert.equal(response.status, 200);
      assert.equal(response.body, body);
      assert.equal(response.headers.get("Content-Type"), extension === "png" ? "image/png" : "image/jpeg");
      assert.equal(response.headers.get("Content-Disposition"), `attachment; filename="VINHUNI-PHOTOBOOTH-${shareId}.${extension}"`);
      assert.equal(response.headers.get("Cache-Control"), "private, no-store");
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), item.bytes);
    }
  } finally { globalThis.fetch = originalFetch; }
});
test("download returns 404 for invalid/missing IDs and sanitizes upstream failures", async () => {
  const originalFetch = globalThis.fetch;
  const originalList = globalThis.__blob.list;
  const call = shareId => download(new Request("https://example.com"), { params: Promise.resolve({ shareId }) });
  try {
    globalThis.fetch = async () => { throw new Error("Should not fetch absent shares"); };
    for (const id of ["invalid", "00000000-0000-4000-8000-000000000000"]) {
      assert.equal((await call(id)).status, 404);
    }
    const id = [...store.values()][0].pathname.split("/")[1];
    globalThis.fetch = async () => new Response(null, { status: 404 });
    assert.equal((await call(id)).status, 404);
    globalThis.fetch = async () => new Response("private upstream detail", { status: 500 });
    const failed = await call(id);
    assert.equal(failed.status, 502);
    assert.deepEqual(await failed.json(), { error: "Download unavailable" });
    globalThis.__blob.list = async () => { throw new Error("private storage detail"); };
    assert.equal((await call(id)).status, 502);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.__blob.list = originalList;
  }
});
test("invalid and absent shares produce not-found; lookup matches exact path and paginates", async () => {
  assert.equal(await findShare("../anything"), null);
  await assert.rejects(SharePage({ params: Promise.resolve({ shareId: "invalid" }) }), /NOT_FOUND/);
  const id = "00000000-0000-4000-8000-000000000000";
  await assert.rejects(SharePage({ params: Promise.resolve({ shareId: id }) }), /NOT_FOUND/);
  const original = globalThis.__blob.list;
  globalThis.__blob.list = async ({ prefix, cursor }) => cursor
    ? { blobs: [{ pathname: `${prefix}final.png`, url: "https://example.com/original" }], hasMore: false }
    : { blobs: [{ pathname: `${prefix}final.jpg.extra` }], hasMore: true, cursor: "next" };
  assert.equal((await findShare(id)).url, "https://example.com/original");
  globalThis.__blob.list = original;
});
test("storage errors are sanitized", async () => {
  const original = globalThis.__blob.authorize;
  globalThis.__blob.authorize = async () => { throw new Error("internal storage details"); };
  const response = await POST(request(new File(["image"], "final.png", { type: "image/png" })));
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: "Upload authorization failed" });
  globalThis.__blob.authorize = original;
});
test("5 MiB and 20 MiB images need only small JSON authorization requests", async () => {
  for (const size of [5 * 1024 * 1024, 20 * 1024 * 1024]) {
    const req = request({ size, contentType: "image/jpeg", pathname: "untrusted/path.jpg" });
    assert.ok((await req.clone().text()).length < 200);
    const response = await POST(req);
    assert.equal(response.status, 201);
    const grant = await response.json();
    assert.equal(grant.pathname, `shares/${grant.shareId}/final.jpg`);
    const file = new File([new Uint8Array(size)], "final.jpg", { type: "image/jpeg" });
    const blob = await globalThis.__blob.put(grant.pathname, file, { token: grant.clientToken, access: "public", contentType: file.type });
    assert.equal(blob.bytes.length, size);
    assert.equal(grants.get(grant.clientToken).maximumSizeInBytes, size);
  }
});
test("development base URL allows only loopback; production origin is fixed", () => {
  process.env.NODE_ENV = "development";
  assert.equal(shareUrl("id", "http://localhost:3000/api/upload"), "http://localhost:3000/p/id");
  assert.equal(shareUrl("id", "https://attacker.example/api/upload"), "https://vinhuni-photobooth-share.vercel.app/p/id");
  process.env.NODE_ENV = "production";
  assert.equal(shareUrl("id", "http://localhost:3000/api/upload"), "https://vinhuni-photobooth-share.vercel.app/p/id");
});

test("native photo sharing preserves JPEG/PNG bytes and uses the download endpoint", async () => {
  const previous = globalThis.fetch;
  try {
    for (const type of ["image/jpeg", "image/png"]) {
      const bytes = Buffer.from([0, 1, 127, 128, 255]);
      globalThis.fetch = async (url) => {
        assert.equal(url, "/api/download/test-id");
        return new Response(bytes, { headers: { "Content-Type": type } });
      };
      let shared;
      const save = createPhotoSaver("/api/download/test-id", "test-id");
      await save({ canShare: ({ files }) => files[0].type === type, share: async data => { shared = data; } }, () => assert.fail("Unexpected fallback"));
      assert.equal(shared.title, "VINHUNI PHOTOBOOTH");
      assert.equal(shared.files[0].type, type);
      assert.equal(shared.files[0].name, `VINHUNI-PHOTOBOOTH-test-id.${type === "image/png" ? "png" : "jpg"}`);
      assert.deepEqual(Buffer.from(await shared.files[0].arrayBuffer()), bytes);
    }
  } finally { globalThis.fetch = previous; }
});

test("photo sharing falls back when unsupported, but not when cancelled", async () => {
  const previous = globalThis.fetch;
  let downloads = 0;
  const fallback = () => { downloads++; };
  try {
    globalThis.fetch = async () => new Response("original", { headers: { "Content-Type": "image/jpeg" } });
    await createPhotoSaver("/api/download/id", "id")({}, fallback);
    assert.equal(downloads, 1);
    await createPhotoSaver("/api/download/id", "id")({ canShare: () => false, share: () => assert.fail("Unexpected share") }, fallback);
    assert.equal(downloads, 2);
    await createPhotoSaver("/api/download/id", "id")({ share: async () => { throw new DOMException("cancel", "AbortError"); } }, fallback);
    assert.equal(downloads, 2);
    await createPhotoSaver("/api/download/id", "id")({ share: async () => { throw new TypeError("unsupported files"); } }, fallback);
    assert.equal(downloads, 3);
  } finally { globalThis.fetch = previous; }
});

test("slow fetch permits a second tap with fresh activation and no refetch", async () => {
  const previous = globalThis.fetch;
  let fetches = 0;
  let shares = 0;
  const activation = { isActive: false };
  try {
    globalThis.fetch = async () => {
      fetches++;
      return new Response("original", { headers: { "Content-Type": "image/png" } });
    };
    const save = createPhotoSaver("/api/download/id", "id");
    const browser = { userActivation: activation, canShare: () => true, share: async () => { shares++; } };
    assert.match(await save(browser, () => assert.fail("Unexpected fallback")), /lần nữa/);
    assert.equal(shares, 0);
    activation.isActive = true;
    await save(browser, () => assert.fail("Unexpected fallback"));
    assert.equal(shares, 1);
    assert.equal(fetches, 1);
  } finally { globalThis.fetch = previous; }
});

test("failed image fetch reports retry without sharing error content", async () => {
  const previous = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response("upstream error", { status: 502 });
    const message = await createPhotoSaver("/api/download/id", "id")({ share: () => assert.fail("Unexpected share") }, () => assert.fail("Unexpected fallback"));
    assert.match(message, /Vui lòng thử lại/);
  } finally { globalThis.fetch = previous; }
});

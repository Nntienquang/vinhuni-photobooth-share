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
const { default: SharePage } = await import(compile("app/p/[shareId]/page.tsx", {
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
    assert.ok(html.includes(`href="${stored.url}"`));
    assert.ok(html.includes('download=""'));
    assert.ok(html.includes("TẢI ẢNH"));
    assert.ok(!html.includes(key));
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

# VINHUNI PHOTOBOOTH — Cloud photo sharing

Standalone Next.js App Router service deployed at https://vinhuni-photobooth-share.vercel.app.
An authorized local photobooth requests a scoped upload token from this service, then sends its original image directly to public Vercel Blob storage and receives a public share link. No database, QR generation, browser upload form, accounts, or local photobooth integration is included.

## Environment

Configure server-side environment variables in the existing Vercel project:

- `UPLOAD_API_KEY`: required for Bearer authentication.
- `BLOB_READ_WRITE_TOKEN`: required by the official Blob SDK for upload and lookup.
- `BLOB_STORE_ID`: existing infrastructure variable; not read by this application.
- `BLOB_WEBHOOK_PUBLIC_KEY`: existing infrastructure variable; not read by this application (no webhook).

Use an ignored `.env.local` for local development if live storage tests are needed. Never commit values, print credentials, or prefix these variables with `NEXT_PUBLIC_`. A missing API key fails closed with 401. Public Blob access is intentional: anyone with a photo URL can view it.

## Development and deployment

Use Node.js 20.9+ (Node.js 24 was used for validation).

```bash
npm install
npm run dev
```

The existing Vercel project uses the Next.js preset, `npm run build`, and the public `vinhuni-photobooth-images` Blob store. Keep that store connected and make the required environment variables available to the intended deployment environment. No infrastructure recreation is necessary. Environment changes require a new deployment. This implementation does not deploy or push automatically.

Production builds always return the production domain in `shareUrl`. Development requests use their origin only for localhost, 127.0.0.1, or IPv6 loopback; other origins fall back to production. Preview builds also return production share links, so use the preview host manually when reviewing a preview deployment.

Image bytes now bypass Vercel Functions. Files above the 4.5 MB Function request limit are supported up to the application limit of 20 MiB using direct Blob uploads. Only small authorization metadata passes through the Function.

Reference: https://vercel.com/docs/vercel-blob/client-upload.

## Upload contract

This is a **breaking transport change**: multipart file POSTs are no longer accepted. The local integration must adopt these two steps. No local photobooth/Bridge code is changed in this repository.

### 1. Authorize (small JSON request)

`POST /api/upload`

- Header: `Authorization: Bearer <UPLOAD_API_KEY>`
- Content-Type: `application/json`
- Body: `{ "contentType": "image/jpeg", "size": 6291456 }`
- MIME: `image/jpeg` or `image/png`; size must be an integer from 1 through 20,971,520 bytes (20 MiB).
- Maximum authorization body: 4 KiB, also enforced without Content-Length.
- HTTP 201 authorizes an upload; it does **not** mean the photo has been stored.

Response fields:

```json
{
  "shareId": "server-generated-uuid",
  "shareUrl": "https://vinhuni-photobooth-share.vercel.app/p/server-generated-uuid",
  "pathname": "shares/server-generated-uuid/final.jpg",
  "clientToken": "<short-lived scoped upload token>",
  "expiresAt": 1790000000000
}
```

The server generates a UUID v4 and signs a token using the official `generateClientTokenFromReadWriteToken` SDK function. The grant is restricted to that pathname, one MIME type, at most the declared byte count (never more than 20 MiB), no suffix, no overwrite, and a ten-minute expiry. Client-supplied paths/IDs cannot change the destination. `BLOB_READ_WRITE_TOKEN` is never returned. Treat the scoped `clientToken` as temporary authorization: keep it in memory, do not log it or put it in the public share URL.

### 2. Upload directly to Blob

The local client calls `put` from **`@vercel/blob/client`**, using the returned pathname and token, `access: "public"`, and the original bytes. This request goes to Vercel Blob, not the Next.js endpoint. Blob enforces the signed maximum size, MIME and pathname constraints. MIME is declared, not validated by an image decoder; a maximum-size grant does not enforce exact size or non-empty content against a deliberately dishonest authorized client.

After `put` succeeds, form the final result from the authorization and Blob responses:

```json
{
  "shareId": "example-id",
  "shareUrl": "https://vinhuni-photobooth-share.vercel.app/p/example-id",
  "imageUrl": "https://..."
}
```

Do not report success or show the share link until Blob confirms completion. A failed/expired upload is not a completed share. No callback or database is required: existing share pages find the completed object using their unchanged server-side lookup.

Integration example (documentation only; run from a trusted local process, never a public browser page):

```js
import { readFile } from "node:fs/promises";
import { put } from "@vercel/blob/client";

const contentType = "image/jpeg"; // Use image/png for PNG.
const bytes = await readFile("final.jpg");
const response = await fetch(
  "https://vinhuni-photobooth-share.vercel.app/api/upload",
  {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.UPLOAD_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ contentType, size: bytes.byteLength }),
  },
);
if (!response.ok) throw new Error(`Upload authorization failed: ${response.status}`);
const grant = await response.json();
const blob = await put(grant.pathname, bytes, {
  access: "public",
  token: grant.clientToken,
  contentType,
});
const result = {
  shareId: grant.shareId,
  shareUrl: grant.shareUrl,
  imageUrl: blob.url,
};
// Return result to the caller. Never log grant/clientToken or API credentials.
```

Use the official SDK for the direct upload rather than inventing a raw HTTP Blob protocol. The local SDK client does not need the store's read-write token.

Paths remain `shares/{shareId}/final.jpg` or `shares/{shareId}/final.png`. The source bytes are not resized, recompressed, reoriented, or otherwise transformed.

Authorization endpoint errors use `{ "error": "..." }`:

| Status | Error |
| --- | --- |
| 401 | Unauthorized (missing, malformed, incorrect Bearer key, or absent server key) |
| 400 | Expected application/json / Missing upload metadata / Invalid JSON / Invalid upload metadata / Invalid file size / Empty file |
| 415 | Unsupported file type |
| 413 | File too large (declared file size or authorization body exceeds its limit) |
| 502 | Upload authorization failed |

Authentication remains a fixed-length SHA-256 digest comparison with `timingSafeEqual`, before body parsing. Responses are not cached. SDK errors are sanitized. Direct Blob upload errors are returned by the SDK to the local caller, not by this endpoint.

## Public pages and downloads

- `/`: minimal Vietnamese brand and event text.
- `/p/{shareId}`: server-side, paginated Blob prefix lookup with exact `final.jpg`/`final.png` pathname matching. No database or browser credentials.
- Invalid or missing IDs invoke Next.js `notFound()` and display “Ảnh không tồn tại hoặc đã hết hạn.” Non-streamed responses are HTTP 404; Next.js streamed not-found responses may be HTTP 200 with noindex metadata. No loading/Suspense boundary is added here.
- Storage failures show a separate retry message instead of falsely claiming the photo is absent.
- The page displays the entire original image at its natural aspect ratio. “TẢI ẢNH” links directly to that same Blob URL with `download` semantics and a new-tab fallback. Browsers may ignore cross-origin `download`; customers can save the original from the opened image. No optimized image copy is generated.
- Pages request no indexing and use no-referrer metadata. Public links are not access controls. No expiry/deletion scheduler is implemented.

## Validation

```bash
npm run lint
npm test
npm run build
npm start
```

The automated Node tests transpile the actual TypeScript source in memory and mock Blob/framework boundaries. Upload tests cover authentication, malformed metadata, MIME/size limits, bounded JSON bodies, token restrictions, unchanged image bytes, result assembly, and 5 MiB/20 MiB uploads whose authorization requests remain under 200 bytes. Existing lookup, not-found, original-download and safe-origin checks remain. Mock tests do not prove live Blob enforcement or connectivity.

For a live check after configuring credentials and deploying:

1. POST without authorization: expect 401.
2. Run the documented two-step integration with JPEG and PNG, including a real JPG larger than 4.5 MB and no larger than 20 MiB. Confirm the only request to the application contains small JSON; image bytes go directly to Blob.
3. Open the resulting share page and download the original. Compare its SHA-256 against the source.
4. Request grants with size 0 (400), unsupported MIME (415), or size greater than 20 MiB (413). Check Blob rejects use of a grant for another path/type, an oversized body, an expired grant, or overwriting an existing object.
5. Confirm failed direct uploads never produce a completed result. Public invalid/missing share behavior is unchanged.
6. Inspect browser network/source and `.next/static`: no API key or Blob read-write token should be present.

Live Blob uploads, including >4.5 MB files, still require deployment credentials for end-to-end verification. They are architecturally supported by direct upload, but are not demonstrated by the mocked tests.

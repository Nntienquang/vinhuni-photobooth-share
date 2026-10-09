import "server-only";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { generateClientTokenFromReadWriteToken } from "@vercel/blob/client";
import { shareUrl } from "@/lib/shares";

export const runtime = "nodejs";
const MAX_FILE_BYTES = 20 * 1024 * 1024;
// This endpoint receives metadata only. Image bytes go directly to Blob.
const MAX_BODY_BYTES = 4096;

function error(message: string, status: number) {
  return Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const expected = process.env.UPLOAD_API_KEY;
  const match = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/i.exec(request.headers.get("authorization") ?? "");
  if (!expected || !match || !timingSafeEqual(
    createHash("sha256").update(match[1]).digest(),
    createHash("sha256").update(expected).digest(),
  )) return error("Unauthorized", 401);

  if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES) return error("File too large", 413);
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) return error("Expected application/json", 400);

  let metadata: unknown;
  try {
    const reader = request.body?.getReader();
    if (!reader) return error("Missing upload metadata", 400);
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BODY_BYTES) {
          await reader.cancel();
          return error("File too large", 413);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    metadata = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return error("Invalid JSON", 400);
  }

  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return error("Invalid upload metadata", 400);
  const { contentType: mime, size } = metadata as Record<string, unknown>;
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) return error("Invalid file size", 400);
  if (size === 0) return error("Empty file", 400);
  if (size > MAX_FILE_BYTES) return error("File too large", 413);
  if (mime !== "image/jpeg" && mime !== "image/png") return error("Unsupported file type", 415);

  const shareId = randomUUID();
  const extension = mime === "image/jpeg" ? "jpg" : "png";
  const pathname = `shares/${shareId}/final.${extension}`;
  const expiresAt = Date.now() + 10 * 60 * 1000;
  try {
    const clientToken = await generateClientTokenFromReadWriteToken({
      pathname,
      addRandomSuffix: false,
      allowOverwrite: false,
      allowedContentTypes: [mime],
      maximumSizeInBytes: size,
      validUntil: expiresAt,
    });
    // Authorization is not upload completion. The client obtains imageUrl from Blob put().
    return Response.json({ shareId, shareUrl: shareUrl(shareId, request.url), pathname, clientToken, expiresAt }, {
      status: 201, headers: { "Cache-Control": "no-store" },
    });
  } catch {
    // Never return or log SDK errors: they can contain request/credential details.
    return error("Upload authorization failed", 502);
  }
}

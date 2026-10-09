import { readFile } from "node:fs/promises";
import { put } from "@vercel/blob/client";

const BASE_URL = "https://vinhuni-photobooth-share.vercel.app";
const MAX_BYTES = 20 * 1024 * 1024;
let stage = "Local validation";
let httpStatus;

function fail(message) {
  // Only caller-controlled, fixed messages are passed here. Never print SDK errors.
  console.error("UPLOAD FAILED");
  console.error(`HTTP status: ${httpStatus ?? "unavailable (no response status exposed)"}`);
  console.error(`${stage}: ${message}`);
  process.exitCode = 1;
}

async function main() {
  const [filename, ...extra] = process.argv.slice(2);
  if (!filename || extra.length) {
    fail('Usage: node scripts/test-live-upload.mjs "D:\\path\\to\\final.jpg"');
    return;
  }
  const apiKey = process.env.UPLOAD_API_KEY;
  if (!apiKey) {
    fail("Set UPLOAD_API_KEY in the current process environment.");
    return;
  }

  const bytes = await readFile(filename);
  const size = bytes.byteLength;
  if (size === 0 || size > MAX_BYTES) {
    fail("File must contain between 1 byte and 20 MiB.");
    return;
  }
  // Detect signatures instead of trusting a filename extension; no image decoding.
  const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const contentType = bytes.subarray(0, 8).equals(pngSignature)
    ? "image/png"
    : bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      ? "image/jpeg"
      : null;
  if (!contentType) {
    fail("Unsupported file signature; supply an original JPEG or PNG.");
    return;
  }

  stage = "Upload authorization";
  const response = await fetch(`${BASE_URL}/api/upload`, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ contentType, size }),
  });
  httpStatus = response.status;
  if (!response.ok) {
    fail("Server rejected upload authorization. Check the API key, deployment, and file limits.");
    return;
  }
  const { shareId, shareUrl, pathname, clientToken, expiresAt } = await response.json();
  const extension = contentType === "image/jpeg" ? "jpg" : "png";
  if (
    typeof shareId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(shareId) ||
    shareUrl !== `${BASE_URL}/p/${shareId}` ||
    pathname !== `shares/${shareId}/final.${extension}` ||
    typeof clientToken !== "string" || !clientToken.startsWith("vercel_blob_client_") ||
    !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()
  ) {
    fail("Server returned an invalid or expired upload grant.");
    return;
  }

  stage = "Direct Blob upload";
  httpStatus = undefined; // Do not misreport the authorization status as a Blob status.
  const blob = await put(pathname, bytes, {
    access: "public",
    token: clientToken,
    contentType,
    abortSignal: AbortSignal.timeout(10 * 60 * 1000),
  });
  const imageUrl = new URL(blob.url);
  if (blob.pathname !== pathname || imageUrl.protocol !== "https:" ||
      !/^[a-z0-9-]+\.public\.blob\.vercel-storage\.com$/.test(imageUrl.hostname) ||
      imageUrl.pathname !== `/${pathname}` || imageUrl.search || imageUrl.hash ||
      imageUrl.username || imageUrl.password || imageUrl.port) {
    fail("Blob returned unexpected upload details.");
    return;
  }
  console.log("UPLOAD OK");
  console.log(`shareId: ${shareId}`);
  console.log(`shareUrl: ${shareUrl}`);
  console.log(`imageUrl: ${imageUrl.href}`);
}

main().catch((error) => {
  // Some SDK/network errors do not expose an HTTP status. Never dump the error,
  // stack, response body, or token; any of those might contain credentials.
  const status = error?.statusCode ?? error?.status;
  if (Number.isInteger(status) && status >= 100 && status <= 599) httpStatus = status;
  fail(stage === "Local validation"
    ? "Could not read the supplied file. Check its path and permissions."
    : "Request failed or returned an invalid response. Check connectivity, configuration, and token expiry.");
});

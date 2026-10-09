import "server-only";
import { list } from "@vercel/blob";

export const SHARE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const PRODUCTION_ORIGIN = "https://vinhuni-photobooth-share.vercel.app";

export function shareUrl(shareId: string, requestUrl: string) {
  const request = new URL(requestUrl);
  // Only trust loopback origins in development, never forwarded Host headers.
  const local = process.env.NODE_ENV !== "production" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(request.hostname) &&
    ["http:", "https:"].includes(request.protocol);
  return `${local ? request.origin : PRODUCTION_ORIGIN}/p/${shareId}`;
}

export async function findShare(shareId: string) {
  if (!SHARE_ID_PATTERN.test(shareId)) return null;
  const prefix = `shares/${shareId}/`;
  let cursor: string | undefined;
  do {
    const result = await list({ prefix, cursor, limit: 100 });
    const image = result.blobs.find(({ pathname }) =>
      pathname === `${prefix}final.jpg` || pathname === `${prefix}final.png`,
    );
    if (image) return image;
    cursor = result.hasMore ? result.cursor : undefined;
  } while (cursor);
  return null;
}

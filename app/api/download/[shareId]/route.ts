import { findShare } from "@/lib/shares";

export const runtime = "nodejs";

function error(message: string, status: number) {
  return Response.json({ error: message }, {
    status, headers: { "Cache-Control": "private, no-store" },
  });
}

export async function GET(request: Request, { params }: { params: Promise<{ shareId: string }> }) {
  const { shareId } = await params;
  try {
    const image = await findShare(shareId);
    if (!image) return error("Photo not found", 404);
    const upstream = await fetch(image.url, {
      cache: "no-store",
      signal: request.signal,
      redirect: "error",
    });
    if (!upstream.ok || !upstream.body) {
      await upstream.body?.cancel();
      return upstream.status === 404
        ? error("Photo not found", 404)
        : error("Download unavailable", 502);
    }
    const extension = image.pathname.endsWith(".png") ? "png" : "jpg";
    // Stream the original body without buffering or image processing.
    return new Response(upstream.body, {
      headers: {
        "Content-Type": extension === "png" ? "image/png" : "image/jpeg",
        "Content-Disposition": `attachment; filename="VINHUNI-PHOTOBOOTH-${shareId}.${extension}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return error("Download unavailable", 502);
  }
}

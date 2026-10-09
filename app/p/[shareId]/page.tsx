import { notFound } from "next/navigation";
import { findShare } from "@/lib/shares";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function SharePage({ params }: { params: Promise<{ shareId: string }> }) {
  const { shareId } = await params;
  // Sanitize SDK failures before they reach framework error logging.
  const image = await findShare(shareId).catch(() => { throw new Error("Photo storage unavailable"); });
  if (!image) notFound();

  return (
    <main className="shell">
      <p className="brand">VINHUNI PHOTOBOOTH</p>
      <h1>Khoảnh khắc của bạn</h1>
      <figure className="photo-frame">
        {/* Serve the original without Next image optimization. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="photo" src={image.url} alt="Ảnh của bạn tại VINHUNI PHOTOBOOTH" />
      </figure>
      <a className="download" href={image.url} download target="_blank" rel="noopener noreferrer">TẢI ẢNH</a>
      <p className="muted">Nhấn để lưu ảnh chất lượng gốc về thiết bị.</p>
    </main>
  );
}

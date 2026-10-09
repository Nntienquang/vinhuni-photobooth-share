import Link from "next/link";

export default function NotFound() {
  return (
    <main className="shell centered">
      <p className="brand">VINHUNI PHOTOBOOTH</p>
      <h1>Ảnh không tồn tại hoặc đã hết hạn.</h1>
      <Link className="text-link" href="/">Về trang chủ</Link>
    </main>
  );
}

"use client";

export default function ShareError({ reset }: { reset: () => void }) {
  return (
    <main className="shell centered">
      <p className="brand">VINHUNI PHOTOBOOTH</p>
      <h1>Chưa thể tải ảnh lúc này.</h1>
      <p className="muted">Vui lòng thử lại sau ít phút.</p>
      <button className="download" onClick={reset}>THỬ LẠI</button>
    </main>
  );
}

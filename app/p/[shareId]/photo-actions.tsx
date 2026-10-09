"use client";

import { useMemo, useRef, useState } from "react";
import { createPhotoSaver } from "./save-photo";

export default function PhotoActions({ shareId }: { shareId: string }) {
  const url = `/api/download/${shareId}`;
  const save = useMemo(() => createPhotoSaver(url, shareId), [url, shareId]);
  const downloadLink = useRef<HTMLAnchorElement>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function savePhoto() {
    setBusy(true);
    setMessage("Đang chuẩn bị ảnh…");
    try {
      setMessage(await save(navigator, () => downloadLink.current?.click()));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="photo-actions">
      <button type="button" className="download" onClick={savePhoto} disabled={busy} aria-busy={busy}>LƯU VÀO ẢNH</button>
      <p className="muted">Trên iPhone: chọn LƯU VÀO ẢNH, sau đó chọn Lưu hình ảnh trong bảng chia sẻ.</p>
      <a ref={downloadLink} className="download download-secondary" href={url} download>TẢI FILE GỐC</a>
      <p className="muted">File tải xuống nằm trong Tệp &gt; Downloads.</p>
      <p className="muted" role="status" aria-live="polite">{message}</p>
    </div>
  );
}

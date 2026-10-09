// Browser-only interaction; no storage credentials or image transformations.
export function createPhotoSaver(url: string, shareId: string) {
  let file: File | undefined;
  let busy = false;
  return async function save(
    browser: Pick<Navigator, "share" | "canShare" | "userActivation">,
    download: () => void,
  ): Promise<string> {
    if (busy) return "Đang chuẩn bị ảnh…";
    busy = true;
    try {
      if (typeof browser.share !== "function") {
        download();
        return "File tải xuống nằm trong Tệp > Downloads.";
      }
      if (!file) {
        const response = await fetch(url, { cache: "no-store" });
        if (!response.ok) throw new Error("Download failed");
        const blob = await response.blob();
        if (!blob.size || !["image/jpeg", "image/png"].includes(blob.type)) throw new Error("Invalid image");
        const extension = blob.type === "image/png" ? "png" : "jpg";
        file = new File([blob], `VINHUNI-PHOTOBOOTH-${shareId}.${extension}`, { type: blob.type });
      }
      if (typeof browser.canShare === "function" && !browser.canShare({ files: [file] })) {
        download();
        return "File tải xuống nằm trong Tệp > Downloads.";
      }
      // A slow fetch may outlive the browser's user activation. Keep the original
      // File so the next tap can open the sheet immediately without another fetch.
      if (browser.userActivation && !browser.userActivation.isActive) {
        return "Ảnh đã sẵn sàng. Nhấn LƯU VÀO ẢNH lần nữa để mở bảng chia sẻ.";
      }
      try {
        await browser.share({ files: [file], title: "VINHUNI PHOTOBOOTH" });
        return ""; // A resolved share promise does not prove the photo was saved.
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") return "Đã đóng bảng chia sẻ.";
        if (error instanceof Error && error.name === "NotAllowedError") {
          return "Nhấn LƯU VÀO ẢNH lần nữa hoặc chọn TẢI FILE GỐC.";
        }
        download();
        return "Không thể mở bảng chia sẻ. File tải xuống nằm trong Tệp > Downloads.";
      }
    } catch {
      return "Chưa thể tải ảnh. Vui lòng thử lại hoặc chọn TẢI FILE GỐC.";
    } finally {
      busy = false;
    }
  };
}

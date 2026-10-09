import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "VINHUNI PHOTOBOOTH",
  description: "Khoảnh khắc của bạn — VINHUNI PHOTOBOOTH",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="vi"><body>{children}</body></html>;
}

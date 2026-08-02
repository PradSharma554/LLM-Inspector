import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "LLM Execution Inspector",
  description: "Chrome DevTools for AI applications",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">{children}</body>
    </html>
  );
}

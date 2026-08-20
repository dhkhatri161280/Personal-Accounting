import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const sans = Geist({ variable: "--font-sans", subsets: ["latin"] });
const mono = Geist_Mono({ variable: "--font-mono", subsets: ["latin"] });
export const metadata: Metadata = {
  title: "FinTech by DK",
  description: "Private personal accounting and Tally ERP 9 migration workspace.",
  manifest: "/manifest.webmanifest",
  themeColor: "#10223f",
  icons: {
    icon: [
      { url: "/tally-favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/tally-favicon-48.png", sizes: "48x48", type: "image/png" },
      { url: "/tally-icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/tally-icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    shortcut: "/tally-favicon-32.png",
    apple: "/tally-icon-192.png",
  },
  appleWebApp: { capable: true, title: "FinTech by DK", statusBarStyle: "default" },
  openGraph: {
    title: "FinTech by DK",
    description: "Your complete financial history, carried forward.",
    images: [{ url: "/og.png", width: 1746, height: 907 }],
  },
  twitter: {
    card: "summary_large_image",
    title: "FinTech by DK",
    description: "Your complete financial history, carried forward.",
    images: ["/og.png"],
  },
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${sans.variable} ${mono.variable}`}>{children}</body>
    </html>
  );
}

import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = { title: "寸金 · 私人账本", description: "清楚记录每一笔，安心掌握每一天。", applicationName: "寸金", manifest: "/manifest.webmanifest", appleWebApp: { capable: true, statusBarStyle: "default", title: "寸金" } };
export const viewport: Viewport = { themeColor: "#f6f2e9", width: "device-width", initialScale: 1, viewportFit: "cover" };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="zh-CN"><body>{children}</body></html>; }

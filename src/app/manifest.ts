import type { MetadataRoute } from "next";
export default function manifest(): MetadataRoute.Manifest { return { name: "寸金 · 私人账本", short_name: "寸金", description: "移动优先的私人记账工具", start_url: "/", display: "standalone", background_color: "#f7f3ea", theme_color: "#254f3c", lang: "zh-CN", icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "maskable" }] }; }

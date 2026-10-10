import type { MetadataRoute } from "next";

// Served at /manifest.webmanifest and linked from every page by Next.js.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Shakedown Deploy",
    short_name: "Shakedown",
    description: "One Action, Infinity Clouds.",
    start_url: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#17191d",
    icons: [
      { src: "/brand/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/brand/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}

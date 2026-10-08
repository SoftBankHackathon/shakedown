import path from "node:path";
import type { NextConfig } from "next";

// Monorepo root, so Next.js doesn't guess it from stray lockfiles elsewhere on the machine.
const root = path.join(__dirname, "../..");

const nextConfig: NextConfig = {
  async rewrites() {
    return process.env.NEXT_PUBLIC_API_URL === "/engine"
      ? [{ source: "/engine/:path*", destination: "http://127.0.0.1:8700/:path*" }]
      : [];
  },
  // Shared contracts are TypeScript source inside the monorepo.
  transpilePackages: ["@shakedown/contracts"],
  outputFileTracingRoot: root,
  turbopack: { root },
};

export default nextConfig;

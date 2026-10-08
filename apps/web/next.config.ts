import path from "node:path";
import type { NextConfig } from "next";

// Monorepo root, so Next.js doesn't guess it from stray lockfiles elsewhere on the machine.
const root = path.join(__dirname, "../..");

const nextConfig: NextConfig = {
  // Shared contracts are TypeScript source inside the monorepo.
  transpilePackages: ["@shakedown/contracts"],
  outputFileTracingRoot: root,
  turbopack: { root },
};

export default nextConfig;

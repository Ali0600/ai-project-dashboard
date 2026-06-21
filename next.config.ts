import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // better-sqlite3 is a native module; keep it external so Next doesn't try to bundle it.
  serverExternalPackages: ["better-sqlite3"],
  // Emit a self-contained server bundle for a slim Docker image.
  output: "standalone",
};

export default nextConfig;

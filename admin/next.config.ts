import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";

import type { NextConfig } from "next";

// Load env from the single root /.env file BEFORE Next.js inlines NEXT_PUBLIC_*
// vars into the static export. There are no per-app .env files in this repo —
// see /.env.example for the canonical key list. `dotenv` is a transitive dep we
// already get through Next, so no extra package install is required.
loadEnv({ path: resolve(__dirname, "..", ".env") });

// Plain client-rendered SPA — no SSR. `output: 'export'` makes `next build` emit a fully
// static bundle (into `out/`) with no server runtime; all data (the observability log) is
// fetched in the browser at runtime from the Nest backend. `images.unoptimized` is required
// by static export (we ship no <Image> anyway).
const nextConfig: NextConfig = {
  output: "export",
  images: { unoptimized: true },
};

export default nextConfig;

import type { NextConfig } from "next";

// Plain client-rendered SPA — no SSR. `output: 'export'` makes `next build` emit a fully
// static bundle (into `out/`) with no server runtime; all data (the observability log) is
// fetched in the browser at runtime from the Nest backend. `images.unoptimized` is required
// by static export (we ship no <Image> anyway).
const nextConfig: NextConfig = {
  output: "export",
  images: { unoptimized: true },
};

export default nextConfig;

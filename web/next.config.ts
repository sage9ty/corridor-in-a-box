import path from "node:path";

import type { NextConfig } from "next";

// This app renders untrusted-looking strings (corridor ids, anchor names, error
// messages relayed from a service) and is the project's public face, so it ships
// a baseline header set rather than relying on framework defaults. Vercel adds
// HSTS; everything else here is ours.
//
// The CSP is deliberately strict: no external origins are needed at all. Next's
// runtime requires 'unsafe-inline' for its injected bootstrap styles and
// 'unsafe-eval' in development only.
const isDev = process.env.NODE_ENV === "development";

const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  // The page talks to its own /api routes and nothing else.
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  // Clickjacking defence. frame-ancestors is the modern replacement for
  // X-Frame-Options; both are sent because older agents ignore the former.
  "frame-ancestors 'none'",
  "upgrade-insecure-requests",
].join("; ");

const nextConfig: NextConfig = {
  // web/ keeps its own lockfile outside the monorepo's pnpm workspace, so Next
  // sees two and has to guess which one marks the root it traces from, and warns.
  // Pin it to the repo root rather than to web/: lib/registry.ts imports
  // ../../contracts/deployments.json, and a root of web/ puts that file out of
  // reach — Turbopack fails the build with "Can't resolve
  // '../../contracts/deployments.json'".
  outputFileTracingRoot: path.join(import.meta.dirname, ".."),
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=()",
          },
        ],
      },
    ];
  },
};

export default nextConfig;

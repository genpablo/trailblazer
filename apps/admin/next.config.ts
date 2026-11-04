import type { NextConfig } from "next";

const apiUrl = process.env.API_INTERNAL_URL ?? "http://localhost:4000";

const nextConfig: NextConfig = {
  // The browser only talks to the admin origin; /api/* is proxied to the API service, so the
  // session cookie stays first-party and no CORS is needed.
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${apiUrl}/:path*` }];
  },
  poweredByHeader: false,
};

export default nextConfig;

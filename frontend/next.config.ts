import type { NextConfig } from "next";

// Proxy /api/* vers le backend Fastify (pas de CORS côté API : même origine
// vue du navigateur). Backend par défaut sur :3000, frontend dev sur :3001.
const API_URL = process.env.API_URL ?? "http://localhost:3000";

const nextConfig: NextConfig = {
  // Le dépôt a deux lockfiles (backend racine + frontend) : fixer la racine
  // Turbopack évite une inférence incorrecte.
  turbopack: { root: __dirname },
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${API_URL}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;

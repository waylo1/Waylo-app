import { defineConfig, devices } from "@playwright/test";

// Suite e2e Playwright. Démarre le front Next (port 3001, qui proxy /api → le
// backend :3000). PRÉREQUIS : le backend (npm start à la racine) et une base de
// test doivent tourner — Playwright ne lance ici que le front.
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  fullyParallel: true,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3001",
    trace: "on-first-retry",
  },
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3001",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});

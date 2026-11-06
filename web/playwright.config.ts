import { defineConfig } from "@playwright/test";

// Vite is started here; each spec starts its own Go server (see e2e/server.ts).
export default defineConfig({
  testDir: "e2e",
  timeout: 90_000,
  workers: 1,
  webServer: { command: "npm run dev -- --strictPort", url: "http://localhost:5173", reuseExistingServer: true },
});

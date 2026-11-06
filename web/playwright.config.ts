import { defineConfig } from "@playwright/test";

// Starts the Go server and Vite unless they are already running.
export default defineConfig({
  testDir: "e2e",
  timeout: 90_000,
  workers: 1,
  webServer: [
    { command: "go run .", cwd: "../server", port: 8080, reuseExistingServer: true },
    { command: "npm run dev -- --strictPort", url: "http://localhost:5173", reuseExistingServer: true },
  ],
});

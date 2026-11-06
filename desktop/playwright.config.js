const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({ testDir: "e2e", timeout: 120_000, workers: 1 });

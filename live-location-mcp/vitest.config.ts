import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Clear platform env vars so tests don't pick up a deployment's configuration.
    setupFiles: ["../tools/test-env-setup.ts"],
  },
});

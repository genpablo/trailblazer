import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    env: {
      TEST_DATABASE_URL:
        process.env.TEST_DATABASE_URL ?? "postgres://traiblazer:traiblazer@localhost:5433/traiblazer_test",
      TEST_DATABASE_APP_URL:
        process.env.TEST_DATABASE_APP_URL ??
        "postgres://traiblazer_app:traiblazer_app@localhost:5433/traiblazer_test",
    },
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});

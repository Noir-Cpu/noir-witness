import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The tracing middleware logs one JSON line per request; thousands of them bury test output.
    onConsoleLog: (log) => (log.startsWith('{"level"') ? false : undefined),
    testTimeout: 30_000,
  },
});

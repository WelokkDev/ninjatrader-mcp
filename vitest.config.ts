import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Default DB path used by importing src/db/connection.ts at module load.
    // Tests inject in-memory DBs into handler factories where they actually
    // exercise SQL; this just keeps the side-effect import from creating
    // data/candles.db during test runs.
    env: {
      NT_DATA_PATH: ".test-data",
    },
  },
});

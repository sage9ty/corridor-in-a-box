import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@corridor/types": r("./packages/types/src/index.ts"),
      "@corridor/manifest": r("./packages/manifest/src/index.ts"),
      "@corridor/adapter-kit": r("./packages/adapter-kit/src/index.ts"),
      "@corridor/sep31": r("./packages/sep31/src/index.ts"),
      "@corridor/router": r("./packages/router/src/index.ts"),
      "@corridor/engine": r("./packages/engine/src/index.ts"),
      "@corridor/stellar": r("./packages/stellar/src/index.ts"),
      "@corridor/service": r("./packages/service/src/index.ts"),
      "@corridor/cli/wire": r("./packages/cli/src/wire.ts"),
      "@corridor/cli": r("./packages/cli/src/index.ts"),
    },
  },
  test: { include: ["tests/**/*.test.ts"] },
});

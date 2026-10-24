import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Flaky-test quarantine (tests/helpers/quarantine.ts). `pnpm test:quarantine`
// (--mode quarantine, or CORRIDOR_QUARANTINE=1) runs only the blocks tagged
// "[quarantine]", each retried up to 3 times. The plain run leaves the flag
// unset, so the helper skips those blocks there.
export default defineConfig(({ mode }) => {
  const quarantine = mode === "quarantine" || process.env.CORRIDOR_QUARANTINE === "1";
  return {
    resolve: {
      alias: {
        "@corridor/types": r("./packages/types/src/index.ts"),
        // Listed before the package root: a string alias also matches subpaths.
        "@corridor/manifest/liveness": r("./packages/manifest/src/liveness.ts"),
        "@corridor/manifest": r("./packages/manifest/src/index.ts"),
        "@corridor/probe": r("./packages/probe/src/index.ts"),
        "@corridor/adapter-kit": r("./packages/adapter-kit/src/index.ts"),
        "@corridor/sep31": r("./packages/sep31/src/index.ts"),
        "@corridor/sep6": r("./packages/sep6/src/index.ts"),
        "@corridor/router/testing": r("./packages/router/src/testing.ts"),
        "@corridor/router": r("./packages/router/src/index.ts"),
        "@corridor/engine": r("./packages/engine/src/index.ts"),
        "@corridor/stellar": r("./packages/stellar/src/index.ts"),
        "@corridor/service": r("./packages/service/src/index.ts"),
        "@corridor/cli/wire": r("./packages/cli/src/wire.ts"),
        "@corridor/cli": r("./packages/cli/src/index.ts"),
      },
    },
    test: {
      include: ["tests/**/*.test.ts"],
      ...(quarantine && {
        env: { CORRIDOR_QUARANTINE: "1" },
        testNamePattern: /\[quarantine\]/,
        retry: 3,
        // An empty quarantine is the goal state, not a failure.
        passWithNoTests: true,
      }),
    },
  };
});

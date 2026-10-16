// Flat ESLint config. Type-aware linting across the monorepo's TS sources,
// with Prettier owning formatting (eslint-config-prettier turns off any rule
// that would fight the formatter).
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    // web/ is a standalone Next.js app with its own toolchain, outside this
    // workspace, and is gated by typecheck + build rather than by lint.
    //
    // It cannot currently be linted at all: `next lint` was removed in Next 16,
    // and ESLint needs @typescript-eslint/parser to read .ts/.tsx, which throws
    // "typescript-eslint does not support TS 7.0." at import time since web/
    // moved to TypeScript 7. Revisit once typescript-eslint supports TS >=7.1:
    // https://github.com/typescript-eslint/typescript-eslint/issues/10940
    ignores: ["**/dist/**", "**/node_modules/**", "**/.turbo/**", "web/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Money/PII discipline: prefer explicit handling, but allow intentional
      // `void x` discards used to mark deliberately-unused port arguments.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  prettier,
);

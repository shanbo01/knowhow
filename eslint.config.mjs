import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "dist/**",
    "out/**",
    "desktop/dist/**",
    "desktop/src-tauri/target/**",
    "next-env.d.ts",
  ]),
  {
    files: [
      "desktop/src/**/*.{ts,tsx}",
      // Guide favicons are remote, per-guide icons resolved at runtime into
      // object URLs, so there is nothing for next/image to route through
      // here either. Turning the rule off for the file keeps the check
      // deterministic: whether the rule fires varies between environments on
      // identical dependency versions, and an inline disable comment is
      // reported as unused wherever it does not.
      "app/components/guide-favicon.tsx",
    ],
    rules: {
      // The desktop recorder renders inside a Tauri webview, not a Next.js
      // page. Its previews are in-memory data URLs produced by the Rust side,
      // so there is no loader for next/image to route them through.
      "@next/next/no-img-element": "off",
    },
  },
]);

export default eslintConfig;

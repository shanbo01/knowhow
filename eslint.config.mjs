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
    files: ["desktop/src/**/*.{ts,tsx}", "app/components/guide-favicon.tsx"],
    rules: {
      // The desktop recorder renders inside a Tauri webview, and guide favicons
      // load dynamic object URLs / icons where next/image optimization is not applicable.
      "@next/next/no-img-element": "off",
    },
  },
]);

export default eslintConfig;

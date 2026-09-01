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
      // Favicons & desktop recorder previews are loaded dynamically/in-memory,
      // so there is no loader for next/image to route them through.
      "@next/next/no-img-element": "off",
    },
  },
]);

export default eslintConfig;

import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Next.js ビルド成果物の除外 (overlayは除外せず適切なルールで検査する)
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  // Electron CommonJS スクリプト向け設定 (require()を許可し、構文・未使用変数は厳格に検査)
  {
    files: ["overlay/**/*.cjs"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  // オーバーレイ表示・描画スクリプト向け設定 (ブラウザグローバルの許可)
  {
    files: ["overlay/**/*.js"],
    languageOptions: {
      globals: {
        requestAnimationFrame: "readonly",
        window: "readonly",
        document: "readonly",
        console: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
      },
    },
  },
]);

export default eslintConfig;

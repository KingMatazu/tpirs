import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/.turbo/**",
      "**/coverage/**",
      "**/docker-data/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
      "@typescript-eslint/dot-notation": ["error", { allowIndexSignaturePropertyAccess: true }],
    },
  },
  {
    files: ["**/*.mjs", "**/*.js"],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ["**/*.test.ts"],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // Build/tooling files that legitimately sit outside every package's
    // type-checked project (they are not in a `tsconfig.json` include), so the
    // type-aware project service cannot resolve them.
    files: ["**/vitest.config.ts", "**/*.config.ts", "**/migrations/**/*.ts"],
    ...tseslint.configs.disableTypeChecked,
  },
  prettier,
);

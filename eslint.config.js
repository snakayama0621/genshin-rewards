import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

const UNSAFE_HTML_SINKS = ["innerHTML", "outerHTML", "insertAdjacentHTML"].map(
  (property) => ({
    selector: `MemberExpression[property.name='${property}']`,
    message:
      "外部データによるXSSを防ぐため、textContent と DOM API で要素を組み立ててください。",
  }),
);

export default tseslint.config(
  { ignores: ["dist/", "coverage/", "node_modules/"] },
  {
    files: ["**/*.ts"],
    extends: [js.configs.recommended, ...tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.browser, ...globals.serviceworker },
    },
    rules: {
      "no-console": ["error", { allow: ["warn", "error"] }],
      "no-restricted-syntax": ["error", ...UNSAFE_HTML_SINKS],
      "no-restricted-properties": [
        "error",
        {
          object: "document",
          property: "write",
          message: "document.write は使用しないでください。",
        },
      ],
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
    },
  },
  {
    files: ["**/*.js", "**/*.mjs"],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.node },
  },
);

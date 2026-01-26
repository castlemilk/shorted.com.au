/** @type {import("eslint").Linter.Config} */
const config = {
  parser: "@typescript-eslint/parser",
  parserOptions: {
    project: true,
  },
  plugins: ["@typescript-eslint"],
  extends: [
    "plugin:@next/next/recommended",
    "plugin:@typescript-eslint/recommended-type-checked",
    "plugin:@typescript-eslint/stylistic-type-checked",
  ],
  rules: {
    // These opinionated rules are enabled in stylistic-type-checked above.
    // Feel free to reconfigure them to your own preference.
    "@typescript-eslint/array-type": "off",
    "@typescript-eslint/consistent-type-definitions": "off",

    "@typescript-eslint/consistent-type-imports": [
      "warn",
      {
        prefer: "type-imports",
        fixStyle: "inline-type-imports",
      },
    ],
    "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    "@typescript-eslint/require-await": "off",
    "@typescript-eslint/no-misused-promises": [
      "error",
      {
        checksVoidReturn: { attributes: false },
      },
    ],
    "no-restricted-imports": [
      "error",
      {
        patterns: [
          {
            group: ["src/@/*"],
            message:
              'Do not import from "src/@/...". Use "@/..." instead (e.g., "@/lib/utils" not "src/@/lib/utils").',
          },
        ],
      },
    ],
    // Warn about potential React component naming issues
    "@typescript-eslint/naming-convention": [
      "warn",
      {
        selector: "variable",
        format: ["camelCase", "PascalCase", "UPPER_CASE"],
        leadingUnderscore: "allow",
        trailingUnderscore: "allow",
      },
      {
        // React components (functions that return JSX) should be PascalCase
        selector: "function",
        format: ["camelCase", "PascalCase"],
        leadingUnderscore: "allow",
      },
    ],
  },
  overrides: [
    {
      files: ["**/__tests__/**/*", "**/*.test.*", "**/test/**/*"],
      rules: {
        "@typescript-eslint/no-explicit-any": "off",
        "@typescript-eslint/no-unsafe-assignment": "off",
        "@typescript-eslint/no-unsafe-call": "off",
        "@typescript-eslint/no-unsafe-member-access": "off",
        "@typescript-eslint/no-unsafe-return": "off",
        "@typescript-eslint/no-unsafe-argument": "off",
        "@typescript-eslint/no-var-requires": "off",
        "@typescript-eslint/no-unnecessary-type-assertion": "off",
        "@typescript-eslint/no-unused-vars": "off",
      },
    },
    {
      // Chart and widget components deal with dynamic data from external APIs
      // that's difficult to type strictly without excessive type assertions
      files: [
        "**/*chart*.tsx",
        "**/*Chart*.tsx",
        "**/areaChart.tsx",
        "**/brushChart.tsx",
        "**/chart.tsx",
        "**/*widget*.tsx",
        "**/*Widget*.tsx",
        "**/treemap-tooltip.tsx",
        "**/companyProfile.tsx",
        "**/companyStats.tsx",
        "**/use-stock-data.ts",
        "**/client-api.ts",
        "**/shorts-calculations.ts",
        "**/treemap/treeMap.tsx",
        "**/stock-data-service.ts",
      ],
      rules: {
        "@typescript-eslint/no-unsafe-assignment": "warn",
        "@typescript-eslint/no-unsafe-call": "warn",
        "@typescript-eslint/no-unsafe-member-access": "warn",
        "@typescript-eslint/no-unsafe-return": "warn",
        "@typescript-eslint/no-unsafe-argument": "warn",
        "@typescript-eslint/no-redundant-type-constituents": "off",
      },
    },
  ],
};

module.exports = config;

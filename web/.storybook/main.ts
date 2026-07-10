import type { StorybookConfig } from "@storybook/nextjs-vite";
import tsconfigPaths from "vite-tsconfig-paths";

const config: StorybookConfig = {
  framework: "@storybook/nextjs-vite",
  stories: ["../src/**/*.stories.@(ts|tsx)"],
  addons: ["@storybook/addon-vitest"],
  staticDirs: ["../public"],
  viteFinal: async (viteConfig) => {
    viteConfig.plugins = [...(viteConfig.plugins ?? []), tsconfigPaths()];
    // Vite's default publicDir (<root>/public) duplicates the staticDirs copy
    // above: storybook copies ../public into storybook-static CONCURRENTLY
    // with the vite build, and the two recursive copies race on mkdir —
    // intermittent `EEXIST: mkdir ./storybook-static/assets/...` in CI.
    // staticDirs is the single owner of public assets in the build output.
    viteConfig.publicDir = false;
    return viteConfig;
  },
};
export default config;

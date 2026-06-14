import type { StorybookConfig } from "@storybook/nextjs-vite";
import tsconfigPaths from "vite-tsconfig-paths";

const config: StorybookConfig = {
  framework: "@storybook/nextjs-vite",
  stories: ["../src/**/*.stories.@(ts|tsx)"],
  addons: ["@storybook/addon-vitest"],
  staticDirs: ["../public"],
  viteFinal: async (viteConfig) => {
    viteConfig.plugins = [...(viteConfig.plugins ?? []), tsconfigPaths()];
    return viteConfig;
  },
};
export default config;

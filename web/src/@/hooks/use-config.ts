import { type Atom, useAtom } from "jotai";
import { atomWithStorage } from "jotai/utils";

import { type Style } from "@/registry/styles";
import { type Theme } from "@/registry/themes";

export type Config = {
  style: Style["name"];
  theme: Theme["name"];
  radius: number;
};

const configAtom: Atom<Config> = atomWithStorage<Config>("config", {
  style: "default",
  theme: "zinc",
  radius: 0.5,
});

export function useConfig() {
  return useAtom(configAtom);
}

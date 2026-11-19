import { filedNameKey } from "./australian-investors";
import { TRADERS_PATH } from "./traders";

export const filerPath = (code: string) =>
  `${TRADERS_PATH}/asx/${encodeURIComponent(code)}/holders`;
export const filerHref = (code: string, name: string) =>
  `${filerPath(code)}?${new URLSearchParams({ name }).toString()}`;
export const filerId = (code: string, name: string) =>
  `asx/${code}/${filedNameKey(name)}`;

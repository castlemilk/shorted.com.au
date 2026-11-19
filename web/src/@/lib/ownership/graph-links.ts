export const GRAPH_PATH = "/ownership/connections/explore";
export type GraphKind =
  | "company"
  | "person"
  | "account"
  | "organisation"
  | "institution";

export function graphHref(kind: GraphKind, id: string) {
  return `${GRAPH_PATH}/${kind}/${encodeURIComponent(id)}`;
}

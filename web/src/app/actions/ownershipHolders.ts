"use server";

/**
 * The holders workspace's three reads as plain data (spec 14.3, Holders): the
 * directory with each holder's kind and disclosed positions, one holder's
 * connections (its positions joined to each stock's market cap, and its funds), and
 * the holder inspector's content for a selection.
 *
 * THE SAME RULES AS THE OTHER OWNERSHIP ACTIONS. An outage (the retry wrapper's
 * undefined) is ok: false with an empty error; a key the register does not list is
 * a refusal, with its reason in `error` and no request made. Nothing here throws,
 * and only plain rows cross the boundary: the tree and the content are built by
 * holder-tree.ts from structural inputs, so no generated message leaves the server.
 *
 * NO KEY IS CACHED HERE. The holder directory and the connections are the API's
 * own reads (ISR-tagged, KV last-good through getOwnership.ts); the market caps are
 * the desk's default map (ownershipDesk.ts), which keeps its own default-view entry.
 */

import { getInstitutionOrNotFound, listInstitutions } from "./getOwnership";
import { NotFoundError } from "./withRetry";
import { loadOwnershipMap } from "./ownershipDesk";
import { isInstitutionSlug } from "~/@/lib/ownership/kinds";
import { parseSelection } from "~/@/components/ownership/workspace/selection";
import {
  connectionsPage,
  holderFundRow,
  holderInspectorContent,
  holderRowFrom,
  marketCapsOf,
  type HolderConnectionsPage,
  type HolderInspectorContent,
  type HoldersDirectoryPage,
} from "~/@/components/ownership/holders/holder-tree";

/** The directory's page: every holder the register lists today, with room to spare. */
const DIRECTORY_LIMIT = 200;

/** The directory of holders, largest disclosed positions first, as the API orders it. */
export async function loadHolders(): Promise<HoldersDirectoryPage> {
  const answer = await listInstitutions("", "", DIRECTORY_LIMIT, 0);
  if (answer === undefined) return { ok: false, error: "", holders: [], total: 0 };
  return {
    ok: true,
    error: "",
    holders: answer.institutions.map(holderRowFrom),
    total: answer.total,
  };
}

/** The reason a key the register does not list gives: a refusal, not an outage. */
const NOT_LISTED_REASON = "The register lists no holder under this key.";

/** Marks a key the register does not list, apart from an outage (undefined). */
const NOT_LISTED = Symbol("not-listed");

/** One institution read: the answer, undefined for an outage, or NOT_LISTED for a 404. */
async function readInstitution(key: string) {
  try {
    return await getInstitutionOrNotFound(key);
  } catch (err) {
    if (err instanceof NotFoundError) return NOT_LISTED;
    throw err;
  }
}

/**
 * One holder's disclosed connections: its current substantial holdings, each with
 * the stock's market cap when the map holds one, and its index funds and super
 * options. When the map cannot be read the connections are still served, with
 * `capsOk` false and every width a hairline.
 */
export async function loadHolderConnections(key: string): Promise<HolderConnectionsPage> {
  const unknown = (error: string): HolderConnectionsPage => ({
    ok: false,
    error,
    holder: null,
    positions: [],
    funds: [],
    capsOk: false,
  });
  if (!isInstitutionSlug(key)) return unknown("not a holder the register lists");
  const [answer, map] = await Promise.all([readInstitution(key), loadOwnershipMap({})]);
  if (answer === NOT_LISTED) return unknown(NOT_LISTED_REASON);
  const inst = answer?.institution;
  if (!answer || !inst) return unknown("");
  const caps = map.ok ? marketCapsOf(map.stocks) : null;
  return connectionsPage(holderRowFrom(inst), answer.positions, caps, answer.funds.map(holderFundRow));
}

/**
 * The holder inspector's content for a holder and a selection (the raw `?sel=`
 * value, "" for none). Null when the holder cannot be read, so the rail says so.
 */
export async function resolveHolderInspector(key: string, selection: string): Promise<HolderInspectorContent | null> {
  const page = await loadHolderConnections(key);
  if (!page.ok || page.holder === null) return null;
  return holderInspectorContent(page.holder, page.positions, parseSelection(selection), page.funds);
}

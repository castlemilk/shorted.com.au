"use server";

// Server actions for the per-politician CRM.
//
// Every action calls requireAdmin() ITSELF. Server actions are globally
// addressable by action-id and can be POSTed outside the /admin matcher, so the
// middleware gate alone is bypassable — the shape of the sendBroadcast defect
// the 2026-07 audit found.

import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import { revalidatePath } from "next/cache";

import { RegisterReviewService } from "~/gen/registerreview/v1/register_review_pb";
import { requireAdmin } from "~/server/admin";
import { SHORTS_API_URL, serverFetchWithUserAgent } from "../config";

async function crmClient() {
  const admin = await requireAdmin();
  const transport = createConnectTransport({
    fetch: serverFetchWithUserAgent,
    baseUrl: SHORTS_API_URL,
  });
  return {
    client: createClient(RegisterReviewService, transport),
    headers: {
      "X-Internal-Secret": process.env.INTERNAL_SECRET ?? "dev-internal-secret",
      // curated_by / merged_by are read from this header server-side.
      "X-User-Email": admin.email,
      "X-User-Id": admin.userId,
    },
  };
}

export interface CrmProfileSummary {
  slug: string;
  displayName: string;
  partyAb: string;
  chamber: string;
  division: string;
  stateCode: string;
  aphPhid: string;
  photoUrl: string;
  declaredListedCount: number;
  statementCount: number;
  hasDuplicate: boolean;
  curatedFieldCount: number;
}

export interface CrmFact {
  field: string;
  ordinal: number;
  resolvedText: string;
  machineText: string;
  isCurated: boolean;
  curatedBy: string;
  sourceKey: string;
  sourceUrl: string;
  sourceLicence: string;
}

export interface CrmTerm {
  parliament: number;
  chamber: string;
  division: string;
  stateCode: string;
  partyAb: string;
}

export interface CrmDuplicate {
  slug: string;
  displayName: string;
  statementCount: number;
  declaredListedCount: number;
  aphPhid: string;
}

export interface CrmProfile {
  profile: CrmProfileSummary | null;
  terms: CrmTerm[];
  facts: CrmFact[];
  duplicates: CrmDuplicate[];
  photoUrl: string;
  photoLicence: string;
  photoAuthor: string;
  photoSourceUrl: string;
}

const n = (v: unknown) => Number(v ?? 0);

function toSummary(p: Record<string, unknown>): CrmProfileSummary {
  return {
    slug: String(p.slug ?? ""),
    displayName: String(p.displayName ?? ""),
    partyAb: String(p.partyAb ?? ""),
    chamber: String(p.chamber ?? ""),
    division: String(p.division ?? ""),
    stateCode: String(p.stateCode ?? ""),
    aphPhid: String(p.aphPhid ?? ""),
    photoUrl: String(p.photoUrl ?? ""),
    declaredListedCount: n(p.declaredListedCount),
    statementCount: n(p.statementCount),
    hasDuplicate: !!p.hasDuplicate,
    curatedFieldCount: n(p.curatedFieldCount),
  };
}

function toFact(f: Record<string, unknown>): CrmFact {
  return {
    field: String(f.field ?? ""),
    ordinal: n(f.ordinal),
    resolvedText: String(f.resolvedText ?? ""),
    machineText: String(f.machineText ?? ""),
    isCurated: !!f.isCurated,
    curatedBy: String(f.curatedBy ?? ""),
    sourceKey: String(f.sourceKey ?? ""),
    sourceUrl: String(f.sourceUrl ?? ""),
    sourceLicence: String(f.sourceLicence ?? ""),
  };
}

export async function listPoliticianProfiles(
  query = "",
  limit = 50,
  offset = 0,
  duplicatesOnly = false,
): Promise<{ profiles: CrmProfileSummary[]; total: number; duplicateCount: number }> {
  const { client, headers } = await crmClient();
  const resp = await client.listPoliticianProfiles(
    { query, limit, offset, duplicatesOnly },
    { headers },
  );
  return {
    profiles: (resp.profiles ?? []).map((p) => toSummary(p as unknown as Record<string, unknown>)),
    total: n(resp.total),
    duplicateCount: n(resp.duplicateCount),
  };
}

export async function getPoliticianProfile(slug: string): Promise<CrmProfile | null> {
  const { client, headers } = await crmClient();
  try {
    const resp = await client.getPoliticianProfile({ slug }, { headers });
    return {
      profile: resp.profile ? toSummary(resp.profile as unknown as Record<string, unknown>) : null,
      terms: (resp.terms ?? []).map((t) => ({
        parliament: n(t.parliament),
        chamber: String(t.chamber ?? ""),
        division: String(t.division ?? ""),
        stateCode: String(t.stateCode ?? ""),
        partyAb: String(t.partyAb ?? ""),
      })),
      facts: (resp.facts ?? []).map((f) => toFact(f as unknown as Record<string, unknown>)),
      duplicates: (resp.duplicates ?? []).map((d) => ({
        slug: String(d.slug ?? ""),
        displayName: String(d.displayName ?? ""),
        statementCount: n(d.statementCount),
        declaredListedCount: n(d.declaredListedCount),
        aphPhid: String(d.aphPhid ?? ""),
      })),
      photoUrl: String(resp.photoUrl ?? ""),
      photoLicence: String(resp.photoLicence ?? ""),
      photoAuthor: String(resp.photoAuthor ?? ""),
      photoSourceUrl: String(resp.photoSourceUrl ?? ""),
    };
  } catch {
    return null;
  }
}

export type CrmFactAction = "amend" | "suppress" | "reinstate";
const FACT_ACTION_ENUM: Record<CrmFactAction, number> = {
  amend: 1,
  suppress: 2,
  reinstate: 3,
};

export interface CrmResult {
  ok: boolean;
  error?: string;
}

export async function curatePoliticianFact(input: {
  slug: string;
  field: string;
  ordinal: number;
  action: CrmFactAction;
  curatedText?: string;
  rationale: string;
  evidenceUrl?: string;
}): Promise<CrmResult> {
  const { client, headers } = await crmClient();
  try {
    await client.curatePoliticianFact(
      {
        slug: input.slug,
        field: input.field,
        ordinal: input.ordinal,
        action: FACT_ACTION_ENUM[input.action],
        curatedText: input.curatedText ?? "",
        rationale: input.rationale,
        evidenceUrl: input.evidenceUrl ?? "",
      },
      { headers },
    );
    revalidatePath(`/admin/register/politicians/${input.slug}`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function setPoliticianPhoto(input: {
  slug: string;
  photoUrl: string;
  photoLicence: string;
  photoAuthor: string;
  photoSourceUrl: string;
}): Promise<CrmResult> {
  const { client, headers } = await crmClient();
  try {
    await client.setPoliticianPhoto(input, { headers });
    revalidatePath(`/admin/register/politicians/${input.slug}`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function mergePoliticians(input: {
  keepSlug: string;
  mergeSlug: string;
  evidence: string;
}): Promise<CrmResult> {
  const { client, headers } = await crmClient();
  try {
    await client.mergePoliticians(input, { headers });
    revalidatePath(`/admin/register/politicians/${input.keepSlug}`);
    revalidatePath("/admin/register/politicians");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

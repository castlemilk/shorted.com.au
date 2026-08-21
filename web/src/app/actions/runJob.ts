"use server";

import { revalidatePath } from "next/cache";
import { SHORTS_API_URL } from "./config";
import { requireAdmin } from "~/server/admin";

/**
 * On-demand execution of a scheduled job ("Run now" in the admin console).
 *
 * Mirrors getJobsOverview.ts: admin-gated IN the action (server actions are
 * addressable by action-id, so /admin middleware is not the gate), and the
 * INTERNAL_SERVICE_SECRET never leaves the server. The backend re-validates the
 * job name against the fleet it has actually collected — this action is a
 * courier, not the authority.
 */

const INTERNAL_SECRET = process.env.INTERNAL_SERVICE_SECRET ?? "dev-internal-secret";

/** Machine-readable refusal codes emitted by POST /api/admin/jobs/run. */
export type RunJobCode =
  | "unknown_job"
  | "retired"
  | "not_executable"
  | "already_running"
  | "not_configured"
  | "invalid_body"
  | "run_failed"
  | "request_failed";

export interface RunJobResult {
  ok: boolean;
  /** Present on success — the Cloud Run execution that was created. */
  executionName?: string;
  message: string;
  code?: RunJobCode;
  /**
   * True only for an already-running refusal. The UI must offer the force
   * override ONLY when the backend says the refusal is overridable, so a
   * "retired" or "unknown" refusal can never be forced past.
   */
  forceable?: boolean;
  /** The in-flight execution blocking the run (already_running only). */
  blockingExecution?: string;
}

interface RunJobResponse {
  executionName?: string;
  displayName?: string;
  region?: string;
  error?: string;
  message?: string;
  forceable?: boolean;
}

export async function runJobNow(input: {
  job: string;
  region?: string;
  force?: boolean;
}): Promise<RunJobResult> {
  const admin = await requireAdmin();

  // No retries: this is a MUTATION. A retried POST after a timeout would start a
  // second execution of a job that may already be running.
  try {
    const response = await fetch(`${SHORTS_API_URL}/api/admin/jobs/run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${INTERNAL_SECRET}`,
        "x-internal-secret": INTERNAL_SECRET,
        // The audited identity. Verified above by requireAdmin(); the backend
        // treats it as a label, never as authorisation.
        "x-admin-actor": admin.email,
        "User-Agent": "Mozilla/5.0 (compatible; ShortedAdmin)",
      },
      body: JSON.stringify({
        job: input.job,
        region: input.region ?? "",
        force: input.force ?? false,
      }),
      cache: "no-store",
    });

    const body = (await response.json().catch(() => ({}))) as RunJobResponse;

    if (!response.ok) {
      return {
        ok: false,
        code: (body.error as RunJobCode) ?? "request_failed",
        message: body.message ?? `Request failed (HTTP ${response.status})`,
        forceable: body.forceable === true,
        blockingExecution: body.executionName,
      };
    }

    // The console reads job state server-side; drop its cache so a refresh shows
    // the new execution rather than the pre-run status.
    revalidatePath("/admin");

    return {
      ok: true,
      executionName: body.executionName,
      message: body.executionName
        ? `Execution started: ${body.executionName}`
        : "Execution started",
    };
  } catch (err) {
    console.error("Failed to run job:", err);
    return {
      ok: false,
      code: "request_failed",
      message: err instanceof Error ? err.message : "Request failed",
    };
  }
}

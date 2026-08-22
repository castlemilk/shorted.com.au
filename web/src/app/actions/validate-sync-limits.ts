/**
 * Shared limits for the per-stock sync validation surface.
 *
 * These live OUTSIDE validateSync.ts because that file is `"use server"`, and a
 * server-actions module may only export async functions — exporting a plain
 * const from it fails the production build (tsc and jest do not catch this;
 * only `next build` does).
 */

/** Mirrors the backend cap on `-validate-days` (jobmonitor.NormalizeValidationDays). */
export const MAX_VALIDATE_DAYS = 30;

/** Default number of published ASIC dates a validation run re-reads. */
export const DEFAULT_VALIDATE_DAYS = 7;

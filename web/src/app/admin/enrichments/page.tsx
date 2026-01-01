import Link from "next/link";
import Image from "next/image";
import { auth } from "~/server/auth";
import Container from "@/components/ui/container";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getPendingEnrichments } from "~/app/actions/getPendingEnrichments";
import { getEnrichmentComparison } from "~/app/actions/getEnrichmentComparison";
import { reviewEnrichmentAction } from "~/app/actions/reviewEnrichment";
import { triggerEnrichmentAction } from "~/app/actions/triggerEnrichment";
import { EnrichmentStatus } from "~/gen/shorts/v1alpha1/shorts_pb";
import { EnrichmentJobsStatus } from "@/components/admin/enrichment-jobs-status";

export const dynamic = "force-dynamic";

async function triggerEnrichmentFormAction(formData: FormData) {
  "use server";
  await triggerEnrichmentAction(formData);
}

interface AdminEnrichmentsPageProps {
  searchParams: Promise<{
    id?: string;
  }>;
}

function formatPeople(
  people: Array<{ name: string; role: string; bio: string }> | undefined | null,
) {
  if (!people || people.length === 0) return "";
  return people
    .map(
      (p) =>
        `${p.name}${p.role ? ` — ${p.role}` : ""}${p.bio ? `: ${p.bio}` : ""}`,
    )
    .join("\n");
}

function formatReports(
  reports:
    | Array<{
        url: string;
        title: string;
        type: string;
        date: string;
        source: string;
      }>
    | undefined
    | null,
) {
  if (!reports || reports.length === 0) return "";
  return reports
    .map((r) => `${r.title || "Report"} (${r.date || "n/a"}) — ${r.url}`)
    .join("\n");
}

function formatStringArray(arr: string[] | undefined | null) {
  if (!arr || arr.length === 0) return "";
  return arr.join("\n");
}

function diffCellClass(isDiff: boolean) {
  return isDiff ? "bg-amber-50 dark:bg-amber-900/20" : "";
}

export default async function AdminEnrichmentsPage({
  searchParams,
}: AdminEnrichmentsPageProps) {
  const session = await auth();
  if (!session?.user?.email) {
    return (
      <Container>
        <Card>
          <CardHeader>
            <CardTitle>Admin Enrichments</CardTitle>
            <CardDescription>You must be signed in.</CardDescription>
          </CardHeader>
        </Card>
      </Container>
    );
  }

  const { id } = await searchParams;
  const pending = await getPendingEnrichments(100, 0);

  const selected = id ? pending.find((p) => p.enrichmentId === id) : undefined;
  const comparison =
    selected?.stockCode && selected?.enrichmentId
      ? await getEnrichmentComparison(selected.stockCode, selected.enrichmentId)
      : null;

  const current = comparison?.current;
  const v2 = comparison?.pending?.data;
  const quality = comparison?.pending?.qualityScore;

  const currentKeyPeople = current?.keyPeople?.map((p) => ({
    name: p.name,
    role: p.role,
    bio: p.bio,
  }));
  const v2KeyPeople = v2?.keyPeople?.map((p) => ({
    name: p.name,
    role: p.role,
    bio: p.bio,
  }));

  const currentReports = current?.financialReports?.map((r) => ({
    url: r.url,
    title: r.title,
    type: r.type,
    date: r.date,
    source: r.source,
  }));
  const v2Reports = v2?.financialReports?.map((r) => ({
    url: r.url,
    title: r.title,
    type: r.type,
    date: r.date,
    source: r.source,
  }));

  const fields = [
    {
      label: "Logo (Main)",
      v1: current?.gcsUrl ?? "",
      v2: v2?.logoGcsUrl ?? "", // Pending logo from enrichment data
      isImage: true,
    },
    {
      label: "Logo (Icon)",
      v1: current?.logoIconGcsUrl ?? "",
      v2: v2?.logoIconGcsUrl ?? "",
      isImage: true,
    },
    {
      label: "Enhanced Summary",
      v1: current?.enhancedSummary ?? "",
      v2: v2?.enhancedSummary ?? "",
    },
    {
      label: "Company History",
      v1: current?.companyHistory ?? "",
      v2: v2?.companyHistory ?? "",
    },
    {
      label: "Competitive Advantages",
      v1: current?.competitiveAdvantages ?? "",
      v2: v2?.competitiveAdvantages ?? "",
    },
    {
      label: "Recent Developments",
      v1: current?.recentDevelopments ?? "",
      v2: v2?.recentDevelopments ?? "",
    },
    {
      label: "Risk Factors",
      v1: formatStringArray(current?.riskFactors),
      v2: formatStringArray(v2?.riskFactors),
    },
    {
      label: "Tags",
      v1: formatStringArray(current?.tags),
      v2: formatStringArray(v2?.tags),
    },
    {
      label: "Key People",
      v1: formatPeople(currentKeyPeople),
      v2: formatPeople(v2KeyPeople),
    },
    {
      label: "Financial Reports",
      v1: formatReports(currentReports),
      v2: formatReports(v2Reports),
    },
  ];

  return (
    <Container>
      <div className="flex flex-col gap-6">
        <div className="flex items-center justify-between">
          <div className="flex flex-col gap-1">
            <h1 className="text-2xl font-semibold">Enrichment Review</h1>
            <p className="text-sm text-muted-foreground">
              Compare current (v1) company-metadata vs pending (v2) enrichment,
              then approve/reject.
            </p>
          </div>
          <Link
            href="/admin"
            className="text-sm underline text-muted-foreground"
          >
            Back to Admin
          </Link>
        </div>

        <EnrichmentJobsStatus />

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <Card className="lg:col-span-4">
            <CardHeader>
              <CardTitle>Pending Queue</CardTitle>
              <CardDescription>
                {pending.length} pending enrichment(s)
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <Card className="border-dashed">
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm">Trigger Enrichment</CardTitle>
                  <CardDescription className="text-xs">
                    Start a new enrichment for a stock
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <form
                    action={triggerEnrichmentFormAction}
                    className="flex flex-col gap-3"
                  >
                    <div className="flex flex-col gap-2">
                      <Label htmlFor="stockCode" className="text-xs">
                        Stock Code
                      </Label>
                      <Input
                        id="stockCode"
                        name="stockCode"
                        placeholder="e.g., CBA, BHP"
                        className="h-9 text-sm"
                        required
                        pattern="[A-Z0-9]{3,4}"
                        title="3-4 uppercase letters/numbers"
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        id="force"
                        name="force"
                        value="true"
                        className="h-4 w-4 rounded border-gray-300"
                      />
                      <Label htmlFor="force" className="text-xs cursor-pointer">
                        Force re-enrichment (even if already enriched)
                      </Label>
                    </div>
                    <Button type="submit" size="sm" className="w-full">
                      Trigger Enrichment
                    </Button>
                  </form>
                </CardContent>
              </Card>
              <div className="overflow-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Stock</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Score</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pending.length === 0 ? (
                      <TableRow>
                        <TableCell
                          colSpan={3}
                          className="text-sm text-muted-foreground"
                        >
                          No pending enrichments. Use the form above to trigger
                          a new enrichment.
                        </TableCell>
                      </TableRow>
                    ) : (
                      pending.map((p) => (
                        <TableRow
                          key={p.enrichmentId}
                          className={p.enrichmentId === id ? "bg-muted/50" : ""}
                        >
                          <TableCell>
                            <Link
                              href={`/admin/enrichments?id=${encodeURIComponent(p.enrichmentId)}`}
                              className="underline"
                            >
                              {p.stockCode}
                            </Link>
                          </TableCell>
                          <TableCell>
                            <Badge variant="secondary">
                              {p.status === EnrichmentStatus.PENDING_REVIEW
                                ? "pending_review"
                                : p.status === EnrichmentStatus.COMPLETED
                                  ? "completed"
                                  : p.status === EnrichmentStatus.REJECTED
                                    ? "rejected"
                                    : "unknown"}
                            </Badge>
                          </TableCell>
                          <TableCell className="font-mono text-xs">
                            {p.qualityScore?.overallScore?.toFixed?.(2) ??
                              "n/a"}
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>

          <Card className="lg:col-span-8">
            <CardHeader>
              <CardTitle>Comparison</CardTitle>
              <CardDescription>
                {selected
                  ? `Stock ${selected.stockCode} — Enrichment ${selected.enrichmentId}`
                  : "Select a pending enrichment from the queue"}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-6">
              {!comparison || !current || !v2 || !selected ? (
                <div className="text-sm text-muted-foreground">
                  No selection.
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-3">
                    <Badge variant="outline">v1: current</Badge>
                    <Badge variant="outline">v2: pending</Badge>
                    <div className="text-sm text-muted-foreground">
                      Overall score:{" "}
                      <span className="font-mono">
                        {quality?.overallScore?.toFixed?.(2) ?? "n/a"}
                      </span>
                    </div>
                  </div>

                  <div className="overflow-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-[180px]">Field</TableHead>
                          <TableHead>v1</TableHead>
                          <TableHead>v2</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {fields.map((f) => {
                          const isDiff = f.v1.trim() !== f.v2.trim();
                          const isImage = f.isImage === true;
                          return (
                            <TableRow key={f.label}>
                              <TableCell className="font-medium">
                                {f.label}
                              </TableCell>
                              <TableCell className={diffCellClass(isDiff)}>
                                {isImage ? (
                                  f.v1 ? (
                                    <div className="flex items-center gap-2">
                                      <Image
                                        src={f.v1}
                                        alt={`${selected?.stockCode} logo`}
                                        width={64}
                                        height={64}
                                        className="h-16 w-16 object-contain border rounded p-1 bg-white"
                                        unoptimized
                                      />
                                      <a
                                        href={f.v1}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="text-xs text-blue-600 hover:underline"
                                      >
                                        View full size
                                      </a>
                                    </div>
                                  ) : (
                                    <span className="text-muted-foreground">
                                      —
                                    </span>
                                  )
                                ) : (
                                  <pre className="whitespace-pre-wrap text-xs leading-relaxed">
                                    {f.v1 || (
                                      <span className="text-muted-foreground">
                                        —
                                      </span>
                                    )}
                                  </pre>
                                )}
                              </TableCell>
                              <TableCell className={diffCellClass(isDiff)}>
                                {isImage ? (
                                  f.v2 ? (
                                    <div className="flex items-center gap-2">
                                      <Image
                                        src={f.v2}
                                        alt={`${selected?.stockCode} logo (v2)`}
                                        width={64}
                                        height={64}
                                        className="h-16 w-16 object-contain border rounded p-1 bg-white"
                                        unoptimized
                                      />
                                      <a
                                        href={f.v2}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="text-xs text-blue-600 hover:underline"
                                      >
                                        View full size
                                      </a>
                                      <span className="text-xs text-muted-foreground italic">
                                        (applied immediately during processing)
                                      </span>
                                    </div>
                                  ) : (
                                    <span className="text-xs text-muted-foreground italic">
                                      No logo discovered during enrichment
                                    </span>
                                  )
                                ) : (
                                  <pre className="whitespace-pre-wrap text-xs leading-relaxed">
                                    {f.v2 || (
                                      <span className="text-muted-foreground">
                                        —
                                      </span>
                                    )}
                                  </pre>
                                )}
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </div>

                  <Card>
                    <CardHeader>
                      <CardTitle>Review</CardTitle>
                      <CardDescription>
                        Approve or reject this pending enrichment.
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      <form
                        action={reviewEnrichmentAction}
                        className="flex flex-col gap-3"
                      >
                        <input
                          type="hidden"
                          name="enrichmentId"
                          value={selected.enrichmentId}
                        />
                        <input
                          type="hidden"
                          name="stockCode"
                          value={selected.stockCode}
                        />
                        <textarea
                          name="reviewNotes"
                          className="min-h-[100px] w-full rounded-md border bg-background p-2 text-sm"
                          placeholder="Optional review notes…"
                        />
                        <div className="flex gap-2">
                          <button
                            type="submit"
                            name="decision"
                            value="approve"
                            className="rounded-md bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-700"
                          >
                            Approve
                          </button>
                          <button
                            type="submit"
                            name="decision"
                            value="reject"
                            className="rounded-md bg-red-600 px-3 py-2 text-sm font-medium text-white hover:bg-red-700"
                          >
                            Reject
                          </button>
                        </div>
                      </form>
                    </CardContent>
                  </Card>
                </>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </Container>
  );
}

import { getSyncStatus } from "~/app/actions/getSyncStatus";
import Container from "@/components/ui/container";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDistanceToNow } from "date-fns";

export const dynamic = "force-dynamic";

export default async function AdminDashboard() {
  const runs = await getSyncStatus(20);

  // Calculate stats
  const lastRun = runs[0];
  const successfulRuns = runs.filter((r) => r.status === "completed").length;
  const failedRuns = runs.filter((r) => r.status === "failed").length;

  return (
    <Container>
      <div className="space-y-8 py-8">
        <div className="flex items-center justify-between">
          <h1 className="text-3xl font-bold tracking-tight">Admin Dashboard</h1>
          <Badge
            variant={
              lastRun?.status === "completed" ? "default" : "destructive"
            }
            className="text-sm px-3 py-1"
          >
            System Status:{" "}
            {lastRun?.status === "completed" ? "Healthy" : "Attention Needed"}
          </Badge>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Last Sync</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {lastRun
                  ? formatDistanceToNow(new Date(lastRun.startedAt), {
                      addSuffix: true,
                    })
                  : "Never"}
              </div>
              <p className="text-xs text-muted-foreground">
                {lastRun?.status ?? "N/A"}{" "}
                {lastRun
                  ? `in ${lastRun.totalDurationSeconds?.toFixed(1) ?? 0}s`
                  : ""}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">
                Success Rate (Last 20)
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {runs.length > 0
                  ? Math.round((successfulRuns / runs.length) * 100)
                  : 0}
                %
              </div>
              <p className="text-xs text-muted-foreground">
                {successfulRuns} successful, {failedRuns} failed
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">
                Records Updated (Last)
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {lastRun
                  ? (
                      lastRun.shortsRecordsUpdated +
                      lastRun.pricesRecordsUpdated +
                      lastRun.metricsRecordsUpdated
                    ).toLocaleString()
                  : 0}
              </div>
              <p className="text-xs text-muted-foreground">
                Shorts: {lastRun?.shortsRecordsUpdated ?? 0} | Prices:{" "}
                {lastRun?.pricesRecordsUpdated ?? 0}
              </p>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Sync History</CardTitle>
            <CardDescription>
              Recent daily sync job executions and their status.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Status</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead>Shorts</TableHead>
                  <TableHead>Prices</TableHead>
                  <TableHead>Metrics</TableHead>
                  <TableHead>Algolia</TableHead>
                  <TableHead>Environment</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.map((run) => (
                  <TableRow key={run.runId}>
                    <TableCell>
                      <Badge
                        variant={
                          run.status === "completed"
                            ? "secondary"
                            : run.status === "running"
                              ? "outline"
                              : "destructive"
                        }
                      >
                        {run.status}
                      </Badge>
                      {run.errorMessage && (
                        <div
                          className="text-xs text-red-500 mt-1 max-w-[200px] truncate"
                          title={run.errorMessage}
                        >
                          {run.errorMessage}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      {new Date(run.startedAt).toLocaleString()}
                    </TableCell>
                    <TableCell>
                      {run.totalDurationSeconds > 0
                        ? `${run.totalDurationSeconds.toFixed(1)}s`
                        : "-"}
                    </TableCell>
                    <TableCell>{run.shortsRecordsUpdated}</TableCell>
                    <TableCell>{run.pricesRecordsUpdated}</TableCell>
                    <TableCell>{run.metricsRecordsUpdated}</TableCell>
                    <TableCell>{run.algoliaRecordsSynced}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {run.environment} ({run.hostname})
                    </TableCell>
                  </TableRow>
                ))}
                {runs.length === 0 && (
                  <TableRow>
                    <TableCell
                      colSpan={8}
                      className="text-center text-muted-foreground"
                    >
                      No sync history available.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </Container>
  );
}

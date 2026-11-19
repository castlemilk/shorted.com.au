import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";

export default function TradersLoading() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading">
      <DashboardLayout>
        <div className="mx-auto max-w-6xl space-y-6" aria-hidden>
          <div className="h-5 w-40 rounded-sm bg-muted/40" />
          <div className="h-10 w-64 rounded-sm bg-muted/40" />
          <div className="h-5 w-full max-w-lg rounded-sm bg-muted/40" />
          <div className="h-60 rounded-sm border bg-muted/20" />
        </div>
      </DashboardLayout>
    </div>
  );
}

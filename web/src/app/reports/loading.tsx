import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { ReportCardsSkeleton } from "~/@/components/reports/report-skeleton";

export default function ReportsLoading() {
  return (
    <DashboardLayout>
      <ReportCardsSkeleton />
    </DashboardLayout>
  );
}

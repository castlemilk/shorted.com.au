import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { ReportSkeleton } from "~/@/components/reports/report-skeleton";

export default function MonthlyReportLoading() {
  return (
    <DashboardLayout>
      <ReportSkeleton />
    </DashboardLayout>
  );
}

import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { ReportSkeleton } from "~/@/components/reports/report-skeleton";

export default function YearlyReportLoading() {
  return (
    <DashboardLayout>
      <ReportSkeleton />
    </DashboardLayout>
  );
}

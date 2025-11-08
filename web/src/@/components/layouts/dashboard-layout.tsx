import { Sidebar } from "~/@/components/ui/sidebar";

interface DashboardLayoutProps {
  children: React.ReactNode;
  fullWidth?: boolean;
}

export function DashboardLayout({
  children,
  fullWidth = false,
}: DashboardLayoutProps) {
  return (
    <div className="flex min-h-[calc(100vh-3.5rem)]">
      <Sidebar />
      <main className="flex-1 overflow-y-auto">
        <div className={fullWidth ? "py-6 px-4" : "container py-6"}>
          {children}
        </div>
      </main>
    </div>
  );
}

import dynamic from "next/dynamic";

// Dynamically import Sidebar to avoid SSR issues
// Sidebar uses client-side hooks (usePathname, useSession) that don't work during SSR
const Sidebar = dynamic(
  () => import("~/@/components/ui/sidebar").then((mod) => ({ default: mod.Sidebar })),
  {
    ssr: false, // Disable SSR for Sidebar since it uses client-side hooks
  },
);

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

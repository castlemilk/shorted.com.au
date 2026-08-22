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
    <div className="flex min-h-[calc(100vh-4rem)]">
      <Sidebar />
      {/* No `overflow-y-auto` here. It never scrolled — this is a flex child with
          unconstrained height — but it did make <main> the nearest scrollport,
          which silently disabled `position: sticky` for every descendant (the
          suburb profile's context bar among them).
          `min-w-0` is not optional once it is gone: the old overflow value was
          also what zeroed this flex item's automatic minimum size, and without
          either, <main> grows to its widest content (measured 774px at a 390px
          viewport) and the whole page scrolls sideways. */}
      <main className="min-w-0 flex-1">
        <div className={fullWidth ? "py-6 px-4" : "container py-6"}>
          {children}
        </div>
      </main>
    </div>
  );
}

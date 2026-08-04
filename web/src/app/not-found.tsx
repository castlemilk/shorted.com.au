import Link from "next/link";
import { Home, FileText } from "lucide-react";
import { Button } from "~/@/components/ui/button";

export default function NotFound() {
  return (
    <div className="flex min-h-[50vh] items-center justify-center p-8">
      <div className="max-w-md text-center">
        <div className="mb-6 flex justify-center">
          <div className="relative select-none">
            <span className="text-8xl font-black tracking-tighter font-mono text-primary text-glow">
              404
            </span>
            <span className="absolute -right-3 top-1 inline-block h-8 w-[3px] bg-primary animate-pulse" />
          </div>
        </div>

        <h2 className="mb-2 text-2xl font-bold">Page Not Found</h2>
        <p className="mb-8 text-muted-foreground">
          The page you&apos;re looking for doesn&apos;t exist or has been moved.
        </p>

        <div className="flex flex-col gap-3 sm:flex-row sm:justify-center">
          <Button asChild>
            <Link href="/">
              <Home className="mr-2 h-4 w-4" />
              Go Home
            </Link>
          </Button>
          <Button variant="outline" asChild>
            <Link href="/reports">
              <FileText className="mr-2 h-4 w-4" />
              View Reports
            </Link>
          </Button>
        </div>
      </div>
    </div>
  );
}

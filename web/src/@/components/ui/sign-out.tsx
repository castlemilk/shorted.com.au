import { signOut } from "@/auth";
import { Button } from "@/components/ui/button";

export function SignOut() {
  return (
    <form
      action={async () => {
        "use server";
        await signOut({ redirectTo: "/" });
      }}
      className="w-full"
    >
      <Button
        type="submit"
        variant="ghost"
        className="w-full justify-start px-2 py-1.5 text-xs font-normal hover:bg-accent hover:text-accent-foreground"
      >
        Sign out
      </Button>
    </form>
  );
}

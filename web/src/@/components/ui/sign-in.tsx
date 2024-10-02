import { signIn } from "@/auth";

export function SignIn() {
  return (
    <form
      action={async () => {
        "use server";
        await signIn();
      }}
    >
      <button 
        type="submit" 
        className="text-sm px-4 py-2 rounded-md cursor-pointer transition-colors duration-300 ease-in-out bg-white hover:bg-gray-100"
      >
        Sign in
      </button>
    </form>
  );
}

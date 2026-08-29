import { SignIn } from "@clerk/react";
import { useAuth } from "@/hooks/use-auth";

export function AuthGate({ children }: { children: React.ReactNode }) {
  const { userId, authError } = useAuth();
  if (userId) return <>{children}</>;
  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-md">
        <SignIn routing="hash" />
        {authError && <p className="mt-4 text-center text-sm text-destructive">{authError}</p>}
      </div>
    </main>
  );
}

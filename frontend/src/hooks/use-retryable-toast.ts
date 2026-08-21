import { useCallback } from "react";
import { toast } from "sonner";

export function useRetryableToast() {
  const notifyFailure = useCallback(
    (message: string, retry: () => Promise<unknown>) => {
      toast.error(message, {
        action: {
          label: "Retry",
          onClick: () => {
            void retry().catch(() => notifyFailure(message, retry));
          },
        },
      });
    },
    [],
  );

  return useCallback(
    (message: string, retry: () => Promise<unknown>) => {
      void retry().catch(() => notifyFailure(message, retry));
    },
    [notifyFailure],
  );
}

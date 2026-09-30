import { useCallback } from "react";
import { toast } from "sonner";
import { useI18n } from "./use-i18n";

export function useRetryableToast() {
  const { t } = useI18n();
  const notifyFailure = useCallback(
    (message: string, retry: () => Promise<unknown>) => {
      toast.error(message, {
        action: {
          label: t("common.retry"),
          onClick: () => {
            void retry().catch(() => notifyFailure(message, retry));
          },
        },
      });
    },
    [t],
  );

  return useCallback(
    (message: string, retry: () => Promise<unknown>) => {
      void retry().catch(() => notifyFailure(message, retry));
    },
    [notifyFailure],
  );
}

import { toast } from "sonner";
import { errorMessage } from "@/lib/utils";

export function showErrorToast(e: unknown): void {
  toast.error(errorMessage(e));
}

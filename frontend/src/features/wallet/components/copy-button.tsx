import { CheckIcon, CopyIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      toast.success("Copied");
      setTimeout(() => setCopied(false), 1200);
    } catch {
      toast.error("Copy failed");
    }
  };
  return (
    <Button aria-label="Copy" size="icon" variant="ghost" className="size-7" onClick={onCopy}>
      {copied ? <CheckIcon className="size-3.5 text-green-600" /> : <CopyIcon className="size-3.5" />}
    </Button>
  );
}

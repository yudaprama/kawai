import { ChatComposer } from "@/features/chat/components/chat-composer";
import type { useWorkbench } from "@/features/workbench/hooks/use-workbench";

export interface GoalComposerProps {
  workbench: ReturnType<typeof useWorkbench>;
  chipDraft: { text: string; nonce: number } | null;
  onAddFiles?: () => void;
  onAddLink?: () => void;
  onImageToKnowledge: (dataUrl: string, name: string) => Promise<string[]>;
  onSubmit: (text: string, fileIds?: string[]) => void;
  placeholder?: string;
}

/** Goal composer — the single composer region (bottom of the progress rail
 *  + hero on the landing page). Wraps the shared ChatComposer with the
 *  workbench's submit/stop plumbing. The follow-up chips + quote badge live
 *  in follow-up-composer.tsx and are composed above this by the page. */
export function GoalComposer({
  workbench,
  chipDraft,
  onAddFiles,
  onAddLink,
  onImageToKnowledge,
  onSubmit,
  placeholder,
}: GoalComposerProps) {
  const { supervisor } = workbench;
  const composerStatus: "submitted" | "ready" = ["running", "stopping", "awaitingConfirmation"].includes(
    supervisor.status,
  )
    ? "submitted"
    : "ready";
  const isGenerating = composerStatus === "submitted";

  return (
    <>
      <ChatComposer
        agentName="Workbench"
        chipDraft={chipDraft}
        disabled={isGenerating}
        lastUserText={null}
        onAddFiles={onAddFiles}
        onAddLink={onAddLink}
        onImageToKnowledge={onImageToKnowledge}
        onSubmit={onSubmit}
        onStop={supervisor.stop}
        status={composerStatus}
        placeholder={placeholder}
      />
      {workbench.sessionError && (
        <p className="text-destructive mt-2 font-mono text-[11px]">{workbench.sessionError}</p>
      )}
    </>
  );
}

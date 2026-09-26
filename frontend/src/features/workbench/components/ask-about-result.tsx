/** Ask About Step Result (PLAN-ask-about-step-result.md)
 *
 *  "Tanya tentang hasil ini" — a compact inline affordance on step reports
 *  that lets a non-technical user ask a follow-up question about the result
 *  they're looking at. The question rides the `ask_about_step_result` op
 *  (1-step mini-plan, `explain_step_result` tool); the explanation arrives
 *  as the op's resolved return value and renders inline below the report.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Icon } from "@/components/shared/icon";
import { MarkdownView } from "@/features/workbench/components/tool-views/markdown-views";

type AskState =
  | { phase: "idle" }
  | { phase: "running" }
  | { phase: "done"; answer: string }
  | { phase: "error"; message: string };

export function AskAboutResult({
  stepId,
  onAsk,
}: {
  stepId: string;
  /** Submits the question; resolves with the explanation (null on failure). */
  onAsk: (stepId: string, question: string) => Promise<string | null>;
}) {
  const [state, setState] = useState<AskState>({ phase: "idle" });
  const [question, setQuestion] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const q = question.trim();
    if (!q || state.phase === "running") return;
    setState({ phase: "running" });
    try {
      const answer = await onAsk(stepId, q);
      if (answer == null) {
        setState({ phase: "error", message: "Tidak dapat menjelaskan — coba lagi." });
      } else {
        setState({ phase: "done", answer });
      }
    } catch (err) {
      setState({ phase: "error", message: String(err) });
    }
  };

  if (state.phase === "done" || state.phase === "error") {
    return (
      <div className="mt-3 rounded-lg border border-dashed p-3">
        <div className="mb-2 flex items-center gap-2">
          <Icon name="message-circle-question" className="text-primary size-4" />
          <span className="text-foreground text-xs font-bold">Penjelasan</span>
          <button
            className="text-muted-foreground hover:text-foreground ml-auto text-xs"
            onClick={() => setState({ phase: "idle" })}
            type="button"
          >
            Tutup
          </button>
        </div>
        {state.phase === "error" ? (
          <p className="text-destructive text-xs">{state.message}</p>
        ) : (
          <div className="text-foreground text-sm leading-relaxed">
            <MarkdownView text={state.answer} />
          </div>
        )}
      </div>
    );
  }

  if (state.phase === "running") {
    return (
      <div className="mt-3 flex items-center gap-2 rounded-lg border border-dashed p-3">
        <Icon name="loader-circle" className="text-primary size-3.5 animate-spin" />
        <span className="text-muted-foreground text-xs">Menjelaskan hasil…</span>
      </div>
    );
  }

  return (
    <form className="mt-3 flex items-center gap-2" onSubmit={submit}>
      <Input
        className="h-8 flex-1 text-xs"
        onChange={(e) => setQuestion(e.target.value)}
        placeholder="Tanya tentang hasil ini…"
        value={question}
      />
      <Button className="h-8 px-3 text-xs" disabled={!question.trim()} size="sm" type="submit" variant="secondary">
        Tanya
      </Button>
    </form>
  );
}

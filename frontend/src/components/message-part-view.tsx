import { CheckIcon, CopyIcon } from "lucide-react";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from "@/components/ai-elements/tool";
import { renderToolOutput } from "@/components/ai-elements/tool-renderers";
import { Button } from "@/components/ui/button";
import { useCopyButton } from "@/hooks/use-copy-button";
import type { UIMessage } from "@/lib/ai-types";

export function MessagePartView({ message }: { message: UIMessage }) {
  const textPart = message.parts.find((p) => p.type === "text");
  const { handleCopy, copied } = useCopyButton(textPart?.text ?? "");
  const isUser = message.role === "user";

  const toolParts = message.parts.filter((p): p is Extract<typeof p, { type: `tool-${string}` }> =>
    p.type.startsWith("tool-"),
  );
  const reasoningPart = message.parts.find(
    (p): p is Extract<typeof p, { type: "reasoning" }> => p.type === "reasoning",
  );
  const reasoningProvider =
    typeof reasoningPart?.providerMetadata?.provider === "string" ? reasoningPart.providerMetadata.provider : undefined;
  const reasoningLabel =
    reasoningProvider === "on-device"
      ? "on-device model"
      : reasoningProvider
        ? `cloud writer (${reasoningProvider})`
        : "cloud writer";

  return (
    <Message from={message.role} className={message.role === "assistant" ? "items-start" : undefined}>
      {toolParts.map((part) => {
        const output = part.output as { ok?: boolean; summary?: string; data?: unknown } | undefined;
        const displayOutput = output?.summary ?? part.output;
        // Rich renderer first (needs the structured `data` payload); null →
        // generic JSON fallback below.
        const toolName = part.type.replace(/^tool-/, "");
        const rich =
          part.state === "output-available" && output?.data != null ? renderToolOutput(toolName, output.data) : null;
        return (
          <Tool key={part.toolCallId}>
            <ToolHeader state={part.state} type={part.type} input={part.input} />
            <ToolContent>
              {part.input != null && <ToolInput input={part.input} />}
              {rich != null
                ? rich
                : displayOutput != null && <ToolOutput output={displayOutput} errorText={part.errorText} />}
            </ToolContent>
          </Tool>
        );
      })}
      {reasoningPart && reasoningPart.text.length > 0 && (
        <Reasoning isStreaming={reasoningPart.state === "streaming"}>
          <ReasoningTrigger
            getThinkingMessage={(isStreaming, duration) =>
              isStreaming || duration === 0 ? (
                <Shimmer duration={1}>{`${reasoningLabel} thinking…`}</Shimmer>
              ) : duration === undefined ? (
                <p>{reasoningLabel} thought for a few seconds</p>
              ) : (
                <p>
                  {reasoningLabel} thought for {duration} second
                  {duration === 1 ? "" : "s"}
                </p>
              )
            }
          />
          <ReasoningContent>{reasoningPart.text}</ReasoningContent>
        </Reasoning>
      )}
      {textPart && textPart.text.length > 0 && (
        <MessageContent>
          <MessageResponse>{textPart.text}</MessageResponse>
        </MessageContent>
      )}
      {textPart && textPart.text.length > 0 && (
        <div
          className={`flex items-center gap-1 opacity-60 transition-opacity group-hover:opacity-100 ${isUser ? "justify-end" : ""}`}
        >
          <Button onClick={handleCopy} size="icon" variant="ghost" title="Copy message">
            {copied ? <CheckIcon className="size-3.5 text-green-500" /> : <CopyIcon className="size-3.5" />}
          </Button>
        </div>
      )}
    </Message>
  );
}

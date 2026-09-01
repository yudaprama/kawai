"use client";

import type { DynamicToolUIPart, ToolUIPart } from "@/lib/ai-types";
import type { ComponentProps, ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import {
  CheckCircleIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleIcon,
  ClockIcon,
  XCircleIcon,
} from "lucide-react";
import { isValidElement, useState } from "react";

import { CodeBlock } from "./code-block";
import { getToolCallIcon } from "@/features/tools/tool-icon";
import { getToolDescription } from "@/features/tools/tool-description";

export type ToolProps = ComponentProps<typeof Collapsible>;

export const Tool = ({ className, ...props }: ToolProps) => (
  <Collapsible
    className={cn("group not-prose mb-4 w-full rounded-md border", className)}
    {...props}
  />
);

export type ToolPart = ToolUIPart | DynamicToolUIPart;

export interface ToolIconProps {
  type: ToolPart["type"];
  state: ToolPart["state"];
  toolName: string;
  className: string;
}

export type ToolHeaderProps = {
  icon?: ReactNode | ((props: ToolIconProps) => ReactNode);
  title?: string;
  className?: string;
  /** Port of desktop ToolCallView:getToolDescription — when provided, header shows descriptive label */
  input?: unknown;
} & (
  | { type: ToolUIPart["type"]; state: ToolUIPart["state"]; toolName?: never }
  | {
      type: DynamicToolUIPart["type"];
      state: DynamicToolUIPart["state"];
      toolName: string;
    }
);

const statusLabels: Record<ToolPart["state"], string> = {
  "approval-requested": "Awaiting Approval",
  "approval-responded": "Responded",
  "input-available": "Running",
  "input-streaming": "Pending",
  "output-available": "Completed",
  "output-denied": "Denied",
  "output-error": "Error",
};

const statusIcons: Record<ToolPart["state"], ReactNode> = {
  "approval-requested": <ClockIcon className="size-4 text-yellow-600" />,
  "approval-responded": <CheckCircleIcon className="size-4 text-blue-600" />,
  "input-available": <ClockIcon className="size-4 animate-pulse" />,
  "input-streaming": <CircleIcon className="size-4" />,
  "output-available": <CheckCircleIcon className="size-4 text-green-600" />,
  "output-denied": <XCircleIcon className="size-4 text-orange-600" />,
  "output-error": <XCircleIcon className="size-4 text-red-600" />,
};

export const getStatusBadge = (status: ToolPart["state"]) => (
  <Badge className="gap-1.5 rounded-full text-xs" variant="secondary">
    {statusIcons[status]}
    {statusLabels[status]}
  </Badge>
);

// ── P0: dot indicator + icon mapping (ported from desktop/src/components/ToolCallStatusIndicator.tsx:19) ──
type ToolDotStatus = "pending" | "loading" | "success" | "error";

function toDotStatus(state: ToolPart["state"]): ToolDotStatus {
  switch (state) {
    case "output-available":
    case "approval-responded":
      return "success";
    case "output-error":
    case "output-denied":
      return "error";
    case "input-available":
    case "approval-requested":
      return "loading";
    case "input-streaming":
    default:
      return "pending";
  }
}

function dotColor(status: ToolDotStatus): string {
  switch (status) {
    case "success":
      return "bg-green-500";
    case "error":
      return "bg-red-500";
    case "loading":
      return "bg-yellow-500 animate-pulse";
    case "pending":
    default:
      return "bg-gray-400";
  }
}

export const ToolIconWithStatus = ({
  ToolIcon,
  status,
  className,
}: {
  ToolIcon: React.ComponentType<{ className?: string }>;
  status: ToolDotStatus;
  className?: string;
}) => (
  <span className={cn("relative inline-flex", className)}>
    <ToolIcon className="size-4 shrink-0 text-muted-foreground" />
    <span
      className={cn(
        "absolute -top-0.5 -right-0.5 size-2 rounded-full border border-background",
        dotColor(status)
      )}
      aria-hidden
    />
  </span>
);

export const ToolHeader = ({
  className,
  icon,
  title,
  type,
  state,
  toolName,
  input,
  ...props
}: ToolHeaderProps) => {
  const derivedName =
    type === "dynamic-tool" ? toolName : type.split("-").slice(1).join("-");
  const autoTitle = getToolDescription(derivedName, input) ?? derivedName;
  const displayName = title ?? autoTitle;

  const iconClassName = "size-4 shrink-0 text-muted-foreground";
  const resolvedIcon =
    typeof icon === "function"
      ? icon({ className: iconClassName, state, toolName: derivedName, type })
      : icon;

  // default icon from mapping (desktop/src/utils/toolIconMapping.tsx:28)
  const MappingIcon = getToolCallIcon(
    type === "dynamic-tool" ? toolName : type
  );
  const dotStatus = toDotStatus(state);
  const defaultIcon = (
    <ToolIconWithStatus ToolIcon={MappingIcon} status={dotStatus} />
  );

  return (
    <CollapsibleTrigger
      className={cn(
        "flex w-full items-center justify-between gap-4 p-3",
        className
      )}
      {...props}
    >
      <div className="flex items-center gap-2">
        {resolvedIcon ?? defaultIcon}
        <span className="font-medium text-sm">{title ?? displayName}</span>
        {getStatusBadge(state)}
      </div>
      <ChevronDownIcon className="size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
    </CollapsibleTrigger>
  );
};

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>;

export const ToolContent = ({ className, ...props }: ToolContentProps) => (
  <CollapsibleContent
    className={cn(
      "data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 space-y-4 p-4 text-popover-foreground outline-none data-[state=closed]:animate-out data-[state=open]:animate-in",
      className
    )}
    {...props}
  />
);

export type ToolInputProps = ComponentProps<"div"> & {
  input: ToolPart["input"];
};

type ToolArgValue =
  | string
  | number
  | boolean
  | null
  | ToolArgValue[]
  | { [key: string]: ToolArgValue };

function formatArgValue(value: ToolArgValue): string {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null) return JSON.stringify(value, null, 2);
  return String(value);
}

export const ToolInput = ({ className, input, ...props }: ToolInputProps) => {
  const [expandedKeys, setExpandedKeys] = useState<Record<string, boolean>>({});
  const toggleKey = (key: string) =>
    setExpandedKeys((prev) => ({ ...prev, [key]: !prev[key] }));

  // Fallback for non-object inputs (port of desktop/src/components/ToolCallArguments.tsx:22)
  if (input == null || typeof input !== "object" || Array.isArray(input)) {
    const isEmpty = input == null || (typeof input === "object" && Array.isArray(input) && (input as unknown[]).length === 0);
    if (isEmpty) return null;
    return (
      <div className={cn("space-y-2 overflow-hidden", className)} {...props}>
        <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
          Parameters
        </h4>
        <div className="rounded-md bg-muted/50">
          <CodeBlock code={JSON.stringify(input, null, 2)} language="json" />
        </div>
      </div>
    );
  }

  const record = input as Record<string, ToolArgValue>;
  const entries = Object.entries(record);
  if (entries.length === 0) return null;

  return (
    <div className={cn("space-y-2 overflow-hidden", className)} {...props}>
      <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        Parameters
      </h4>
      <div className="rounded-md bg-muted/50 p-3">
        {entries.map(([key, value]) => {
          const text = formatArgValue(value).trim();
          const needsExpansion = text.length > 60 || text.includes("\n");
          const isExpanded = expandedKeys[key];
          return (
            <div key={key} className="font-sans text-sm mb-2 last:mb-0">
              <div
                className={cn(
                  "flex flex-row items-stretch gap-2",
                  !isExpanded && needsExpansion && "min-w-0"
                )}
              >
                <button
                  onClick={() => needsExpansion && toggleKey(key)}
                  className={cn(
                    "text-left text-muted-foreground text-xs font-medium min-w-[110px] shrink-0",
                    needsExpansion ? "cursor-pointer hover:text-foreground" : "cursor-default"
                  )}
                >
                  {key}
                </button>
                <div
                  className={cn(
                    "flex flex-1 items-stretch gap-2 min-w-0",
                    !isExpanded && needsExpansion && "min-w-0"
                  )}
                >
                  {isExpanded ? (
                    <pre className="font-mono text-xs text-muted-foreground whitespace-pre-wrap break-all flex-1">
                      {text}
                    </pre>
                  ) : (
                    <button
                      onClick={() => needsExpansion && toggleKey(key)}
                      className={cn(
                        "text-left font-mono text-xs truncate flex-1 min-w-0",
                        needsExpansion
                          ? "cursor-pointer text-muted-foreground hover:text-foreground"
                          : "cursor-default text-muted-foreground"
                      )}
                      title={needsExpansion ? text : undefined}
                    >
                      {text.split("\n")[0]}
                    </button>
                  )}
                  {needsExpansion && (
                    <button
                      onClick={() => toggleKey(key)}
                      className="flex items-center shrink-0 text-muted-foreground hover:text-foreground"
                      aria-label={isExpanded ? "Collapse" : "Expand"}
                    >
                      <ChevronRightIcon
                        className={cn(
                          "size-3.5 transition-transform",
                          isExpanded && "rotate-90"
                        )}
                      />
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export type ToolOutputProps = ComponentProps<"div"> & {
  output: ToolPart["output"];
  errorText: ToolPart["errorText"];
};

export const ToolOutput = ({
  className,
  output,
  errorText,
  ...props
}: ToolOutputProps) => {
  if ((output === null || output === undefined) && !errorText) {
    return null;
  }

  let Output = <div>{output as ReactNode}</div>;

  if (typeof output === "object" && !isValidElement(output)) {
    Output = (
      <CodeBlock code={JSON.stringify(output, null, 2)} language="json" />
    );
  } else if (typeof output === "string") {
    Output = <CodeBlock code={output} language="json" />;
  }

  return (
    <div className={cn("space-y-2", className)} {...props}>
      <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        {errorText ? "Error" : "Result"}
      </h4>
      <div
        className={cn(
          "overflow-x-auto rounded-md text-xs [&_table]:w-full",
          errorText
            ? "bg-destructive/10 text-destructive"
            : "bg-muted/50 text-foreground"
        )}
      >
        {errorText && <div>{errorText}</div>}
        {Output}
      </div>
    </div>
  );
};

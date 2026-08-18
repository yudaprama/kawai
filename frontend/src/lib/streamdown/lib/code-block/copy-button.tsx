import {
  type ComponentProps,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { copyToClipboard } from "@/lib/clipboard";
import { StreamdownContext } from "../../index";
import { useIcons } from "../icon-context";
import { useCn } from "../prefix-context";
import { useTranslations } from "../translations-context";
import { ACTION_BUTTON_CLASSES } from "../utils";
import { useCodeBlockContext } from "./context";

export type CodeBlockCopyButtonProps = ComponentProps<"button"> & {
  onCopy?: () => void;
  onError?: (error: Error) => void;
  timeout?: number;
};

export const CodeBlockCopyButton = ({
  onCopy,
  onError,
  timeout = 2000,
  children,
  className,
  code: propCode,
  ...props
}: CodeBlockCopyButtonProps & { code?: string }) => {
  const cn = useCn();
  const [isCopied, setIsCopied] = useState(false);
  const timeoutRef = useRef(0);
  const { code: contextCode } = useCodeBlockContext();
  const { isAnimating } = useContext(StreamdownContext);
  const t = useTranslations();
  const code = propCode ?? contextCode;

  const copyToClipboardHandler = async () => {
    if (typeof window === "undefined") {
      onError?.(new Error("Clipboard API not available"));
      return;
    }

    try {
      if (!isCopied) {
        const ok = await copyToClipboard(code);
        if (!ok) {
          onError?.(new Error("Clipboard write failed"));
          return;
        }
        setIsCopied(true);
        onCopy?.();
        timeoutRef.current = window.setTimeout(
          () => setIsCopied(false),
          timeout
        );
      }
    } catch (error) {
      onError?.(error as Error);
    }
  };

  useEffect(
    () => () => {
      window.clearTimeout(timeoutRef.current);
    },
    []
  );

  const icons = useIcons();
  const Icon = isCopied ? icons.CheckIcon : icons.CopyIcon;

  return (
    <button
      className={cn(
        ACTION_BUTTON_CLASSES,
        className
      )}
      data-streamdown="code-block-copy-button"
      disabled={isAnimating}
      onClick={copyToClipboardHandler}
      title={t.copyCode}
      type="button"
      {...props}
    >
      {children ?? <Icon size={14} />}
    </button>
  );
};

import { type ComponentProps, useContext, useEffect } from "react";
import { createPortal } from "react-dom";
import { StreamdownContext } from "../../index";
import { useIcons } from "../icon-context";
import { useCn } from "../prefix-context";
import { lockBodyScroll, unlockBodyScroll } from "../scroll-lock";
import { ACTION_BUTTON_CLASSES } from "../utils";

export interface FullscreenModalProps {
  isOpen: boolean;
  onClose: () => void;
  children: React.ReactNode;
  title: string;
  closeButtonTitle?: string;
  onOpen?: () => void;
  onExit?: () => void;
  portalContainer?: HTMLElement | (() => HTMLElement | null) | null;
  overlayClassName?: string;
  contentClassName?: string;
  showCloseButton?: boolean;
  closeIcon?: React.ReactNode;
}

function resolvePortalContainer(
  container: HTMLElement | (() => HTMLElement | null) | null | undefined
): HTMLElement {
  if (container === undefined || container === null) {
    return document.body;
  }
  if (typeof container === "function") {
    return container() ?? document.body;
  }
  return container;
}

export const FullscreenModal = ({
  isOpen,
  onClose,
  children,
  title,
  closeButtonTitle,
  onOpen,
  onExit,
  portalContainer,
  overlayClassName,
  contentClassName,
  showCloseButton = true,
  closeIcon,
}: FullscreenModalProps) => {
  const { XIcon } = useIcons();
  const cn = useCn();

  // Manage scroll lock and keyboard events
  useEffect(() => {
    if (isOpen) {
      lockBodyScroll();

      const handleEsc = (e: KeyboardEvent) => {
        if (e.key === "Escape") {
          onClose();
        }
      };

      document.addEventListener("keydown", handleEsc);
      return () => {
        document.removeEventListener("keydown", handleEsc);
        unlockBodyScroll();
      };
    }
  }, [isOpen, onClose]);

  // Handle callbacks separately to avoid scroll lock flickering
  useEffect(() => {
    if (isOpen) {
      onOpen?.();
    } else if (onExit) {
      onExit();
    }
  }, [isOpen, onOpen, onExit]);

  if (!isOpen) return null;

  return createPortal(
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: "dialog overlay needs click-to-dismiss"
    <div
      aria-label={title}
      aria-modal="true"
      className={cn(
        "fixed inset-0 z-50 flex items-center justify-center bg-background/95 backdrop-blur-sm",
        overlayClassName
      )}
      data-streamdown="fullscreen-overlay"
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          onClose();
        }
      }}
      role="dialog"
    >
      {showCloseButton && (
        <button
          className={cn(
            "absolute top-4 right-4 z-10 rounded-md p-2 text-muted-foreground transition-all hover:bg-muted hover:text-foreground"
          )}
          onClick={onClose}
          title={closeButtonTitle ?? "Exit fullscreen"}
          type="button"
        >
          {closeIcon ?? <XIcon size={20} />}
        </button>
      )}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: "div with role=presentation is used for event propagation control" */}
      <div
        className={cn("flex size-full items-center justify-center p-4", contentClassName)}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        role="presentation"
      >
        {children}
      </div>
    </div>,
    resolvePortalContainer(portalContainer)
  );
};

export interface FullscreenButtonProps extends Omit<ComponentProps<"button">, "onClick"> {
  children?: React.ReactNode;
  onOpen: () => void;
  onClose?: () => void;
  title?: string;
  disabled?: boolean;
  className?: string;
}

export const FullscreenButton = ({
  children,
  onOpen,
  onClose,
  title,
  disabled = false,
  className,
  ...props
}: FullscreenButtonProps) => {
  const { Maximize2Icon } = useIcons();
  const cn = useCn();
  const { isAnimating } = useContext(StreamdownContext);

  return (
    <button
      className={cn(ACTION_BUTTON_CLASSES, className)}
      disabled={disabled || isAnimating}
      onClick={onOpen}
      title={title ?? "View fullscreen"}
      type="button"
      {...props}
    >
      {children ?? <Maximize2Icon size={14} />}
    </button>
  );
};
"use client";

import type { ComponentProps } from "react";
import { useCallback } from "react";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { FILE_ICON_CDN } from "@/components/shared/file-icon";
import { platform } from "@/platform";
import { usePromptInputAttachments } from "./prompt-input-context";
import { Camera, Clipboard, Monitor } from "lucide-react";

/**
 * Common hook for platform actions that capture content and add it as
 * attachments. Handles preventDefault, platform call, and attachment.
 */
const useAttachmentAction = (
  platformFn: () => Promise<File | File[] | null>,
  onCapture?: (event: Event) => void
) => {
  const attachments = usePromptInputAttachments();

  return useCallback(
    async (event: Event) => {
      event.preventDefault();
      onCapture?.(event);
      if (event.defaultPrevented) return;

      try {
        const result = await platformFn();
        if (result) {
          attachments.add(Array.isArray(result) ? result : [result]);
        }
      } catch (error) {
        if (
          error instanceof DOMException &&
          (error.name === "NotAllowedError" || error.name === "AbortError")
        ) {
          return;
        }
        throw error;
      }
    },
    [onCapture, attachments, platformFn]
  );
};

export type PromptInputActionAddAttachmentsProps = ComponentProps<
  typeof DropdownMenuItem
> & {
  label?: string;
};

export const PromptInputActionAddAttachments = ({
  label = "Add photos or files",
  ...props
}: PromptInputActionAddAttachmentsProps) => {
  const handleSelect = useAttachmentAction(() =>
    platform.pickFiles({ multiple: true })
  );

  return (
    <DropdownMenuItem {...props} onSelect={handleSelect}>
      <img src={`${FILE_ICON_CDN}/image.svg`} alt="" className="mr-2 size-4" /> {label}
    </DropdownMenuItem>
  );
};

export type PromptInputActionCapturePhotoProps = ComponentProps<
  typeof DropdownMenuItem
> & {
  label?: string;
};

export const PromptInputActionCapturePhoto = ({
  label = "Take photo",
  ...props
}: PromptInputActionCapturePhotoProps) => {
  const handleSelect = useAttachmentAction(() => platform.capturePhoto());

  if (!platform.canCapturePhoto) return null;

  return (
    <DropdownMenuItem {...props} onSelect={handleSelect}>
      <Camera className="mr-2 size-4" />
      {label}
    </DropdownMenuItem>
  );
};

export type PromptInputActionAddScreenshotProps = ComponentProps<
  typeof DropdownMenuItem
> & {
  label?: string;
};

export const PromptInputActionAddScreenshot = ({
  label = "Take screenshot",
  onSelect,
  ...props
}: PromptInputActionAddScreenshotProps) => {
  const handleSelect = useAttachmentAction(
    () => platform.captureScreenshot(),
    onSelect
  );

  if (!platform.canCaptureScreenshot) return null;

  return (
    <DropdownMenuItem {...props} onSelect={handleSelect}>
      <Monitor className="mr-2 size-4" />
      {label}
    </DropdownMenuItem>
  );
};

export type PromptInputActionPasteFromClipboardProps = ComponentProps<
  typeof DropdownMenuItem
> & {
  label?: string;
};

export const PromptInputActionPasteFromClipboard = ({
  label = "Paste image from clipboard",
  ...props
}: PromptInputActionPasteFromClipboardProps) => {
  const handleSelect = useAttachmentAction(() =>
    platform.readClipboardImage()
  );

  if (!platform.canReadClipboardImage) return null;

  return (
    <DropdownMenuItem {...props} onSelect={handleSelect}>
      <Clipboard className="mr-2 size-4" />
      {label}
    </DropdownMenuItem>
  );
};

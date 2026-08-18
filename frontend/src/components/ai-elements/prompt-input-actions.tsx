"use client";

import type { ComponentProps } from "react";

import { useCallback } from "react";
import {
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { FILE_ICON_CDN } from "@/components/file-icon";
import { platform } from "@/platform";
import { usePromptInputAttachments } from "./prompt-input-context";
import { Camera, Clipboard, Monitor } from "lucide-react";

export type PromptInputActionAddAttachmentsProps = ComponentProps<
  typeof DropdownMenuItem
> & {
  label?: string;
};

export const PromptInputActionAddAttachments = ({
  label = "Add photos or files",
  ...props
}: PromptInputActionAddAttachmentsProps) => {
  const attachments = usePromptInputAttachments();

  const handleSelect = useCallback(
    async (e: Event) => {
      e.preventDefault();
      const files = await platform.pickFiles({ multiple: true });
      if (files?.length) {
        attachments.add(files);
      }
    },
    [attachments]
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
  const attachments = usePromptInputAttachments();

  const handleSelect = useCallback(
    async (e: Event) => {
      e.preventDefault();
      const photo = await platform.capturePhoto();
      if (photo) {
        attachments.add([photo]);
      }
    },
    [attachments]
  );

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
  const attachments = usePromptInputAttachments();

  const handleSelect = useCallback(
    async (event: Event) => {
      onSelect?.(event);
      if (event.defaultPrevented) {
        return;
      }

      try {
        const screenshot = await platform.captureScreenshot();
        if (screenshot) {
          attachments.add([screenshot]);
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
    [onSelect, attachments]
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
  const attachments = usePromptInputAttachments();

  const handleSelect = useCallback(
    async (e: Event) => {
      e.preventDefault();
      const image = await platform.readClipboardImage();
      if (image) {
        attachments.add([image]);
      }
    },
    [attachments]
  );

  if (!platform.canReadClipboardImage) return null;

  return (
    <DropdownMenuItem {...props} onSelect={handleSelect}>
      <Clipboard className="mr-2 size-4" />
      {label}
    </DropdownMenuItem>
  );
};

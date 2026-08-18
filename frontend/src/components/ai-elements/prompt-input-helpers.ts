import type { FileUIPart } from "@/lib/ai-types";
import { captureScreenshotViaDisplayMedia } from "@/platform/shared-media";

// ============================================================================
// Helpers
// ============================================================================

export const convertBlobUrlToDataUrl = async (url: string): Promise<string | null> => {
  try {
    const response = await fetch(url);
    const blob = await response.blob();
    return new Promise((resolve) => {
      const reader = new FileReader();
      // oxlint-disable-next-line eslint-plugin-unicorn(prefer-add-event-listener)
      reader.onloadend = () => resolve(reader.result as string);
      // oxlint-disable-next-line eslint-plugin-unicorn(prefer-add-event-listener)
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
};

export const captureScreenshot = async (): Promise<File | null> => {
  return captureScreenshotViaDisplayMedia();
};

// ============================================================================
// Paste constants & helpers
// ============================================================================

export const PASTE_CARD_THRESHOLD = 2000;
export const PASTED_TEXT_FILENAME = "pasted-text.txt";

export const isPastedTextAttachment = (
  file: FileUIPart & { id: string }
): boolean =>
  file.type === "file" &&
  file.mediaType === "text/plain" &&
  file.filename === PASTED_TEXT_FILENAME;

export type PastedContentAttachment = FileUIPart & { id: string };

import { createElement } from "react";
import { Icon } from "@/components/shared/icon";
import type { ComponentType } from "react";

export type ToolIconProps = {
  className?: string;
};

const iconWrap = (name: string): ComponentType<ToolIconProps> => {
  const Wrapped = ({ className }: ToolIconProps) => createElement(Icon, { name, className });
  Wrapped.displayName = `Icon(${name})`;
  return Wrapped;
};

/**
 * Maps tool names (after `tool-` prefix or `__` extension delimiter) to icon names.
 * Ported from `desktop/src/utils/toolIconMapping.tsx:28`.
 */
export const getToolIcon = (toolName: string): ComponentType<ToolIconProps> => {
  switch (toolName) {
    case "text_editor":
      return iconWrap("file-pen-line");
    case "shell":
      return iconWrap("terminal");
    case "remember_memory":
      return iconWrap("save");
    case "retrieve_memories":
      return iconWrap("brain");
    case "computer_control":
      return iconWrap("monitor");
    case "screen_capture":
      return iconWrap("camera");
    case "pdf_tool":
      return iconWrap("file-text");
    case "docx_tool":
      return iconWrap("file-text");
    case "xlsx_tool":
      return iconWrap("table-2");
    case "search":
      return iconWrap("search");
    case "read":
      return iconWrap("eye");
    case "create_file":
      return iconWrap("file-plus");
    case "update_file":
      return iconWrap("file-pen-line");
    case "sheets_tool":
      return iconWrap("table-2");
    case "docs_tool":
      return iconWrap("file-text");
    case "delegate":
      return iconWrap("users");
    case "load":
      return iconWrap("eye");
    case "final_output":
      return iconWrap("wrench");
    // kawai / knowledge tools
    case "knowledge_search":
      return iconWrap("search");
    case "knowledge_add_to_session":
    case "office_index_file":
    case "office_import_file":
      return iconWrap("file-text");
    case "office_create_deck":
      return iconWrap("presentation");
    case "office_export_deck":
      return iconWrap("file-down");
    default:
      return iconWrap("wrench");
  }
};

export const getExtensionIcon = (extensionName: string): ComponentType<ToolIconProps> => {
  switch (extensionName) {
    case "developer":
      return iconWrap("code-2");
    case "memory":
      return iconWrap("brain");
    case "computercontroller":
      return iconWrap("monitor");
    default:
      return iconWrap("wrench");
  }
};

export const extractToolName = (toolCallName: string): string => {
  // handles both `developer__text_editor` and `tool-text_editor`
  const doubleUnderscore = toolCallName.lastIndexOf("__");
  if (doubleUnderscore !== -1) return toolCallName.substring(doubleUnderscore + 2);
  const dash = toolCallName.lastIndexOf("-");
  // for `tool-knowledge_search` we want `knowledge_search`
  if (dash !== -1 && toolCallName.startsWith("tool-")) return toolCallName.substring(dash + 1);
  return toolCallName;
};

export const extractExtensionName = (toolCallName: string): string => {
  const idx = toolCallName.lastIndexOf("__");
  return idx === -1 ? "" : toolCallName.substring(0, idx);
};

export const getToolCallIcon = (toolCallName: string, useExtensionIcon = false): ComponentType<ToolIconProps> => {
  if (useExtensionIcon) {
    const ext = extractExtensionName(toolCallName);
    return getExtensionIcon(ext);
  }
  const name = extractToolName(toolCallName);
  return getToolIcon(name);
};

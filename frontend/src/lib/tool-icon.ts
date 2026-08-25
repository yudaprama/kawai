import {
  Brain,
  Camera,
  Code2,
  Eye,
  FilePenLine,
  FilePlus,
  FileText,
  Monitor,
  Save,
  Search,
  Table2,
  Terminal,
  Users,
  Wrench,
} from "lucide-react";
import type { ComponentType } from "react";

export type ToolIconProps = {
  className?: string;
};

/**
 * Maps tool names (after `tool-` prefix or `__` extension delimiter) to icons.
 * Ported from `desktop/src/utils/toolIconMapping.tsx:28`.
 */
export const getToolIcon = (toolName: string): ComponentType<ToolIconProps> => {
  switch (toolName) {
    case "text_editor":
      return FilePenLine;
    case "shell":
      return Terminal;
    case "remember_memory":
      return Save;
    case "retrieve_memories":
      return Brain;
    case "computer_control":
      return Monitor;
    case "screen_capture":
      return Camera;
    case "pdf_tool":
      return FileText;
    case "docx_tool":
      return FileText;
    case "xlsx_tool":
      return Table2;
    case "search":
      return Search;
    case "read":
      return Eye;
    case "create_file":
      return FilePlus;
    case "update_file":
      return FilePenLine;
    case "sheets_tool":
      return Table2;
    case "docs_tool":
      return FileText;
    case "delegate":
      return Users;
    case "load":
      return Eye;
    case "final_output":
      return Wrench;
    // kawai / knowledge tools
    case "knowledge_search":
      return Search;
    case "knowledge_add_to_session":
    case "office_index_file":
    case "office_import_file":
      return FileText;
    default:
      return Wrench;
  }
};

export const getExtensionIcon = (extensionName: string): ComponentType<ToolIconProps> => {
  switch (extensionName) {
    case "developer":
      return Code2;
    case "memory":
      return Brain;
    case "computercontroller":
      return Monitor;
    default:
      return Wrench;
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

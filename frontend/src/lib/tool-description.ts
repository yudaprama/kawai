import { extractToolName } from "./tool-icon";

type ToolArgValue =
  | string
  | number
  | boolean
  | null
  | ToolArgValue[]
  | { [key: string]: ToolArgValue };

interface ToolGraphNode {
  tool: string;
  description: string;
  depends_on: number[];
}

function snakeToTitleCase(s: string): string {
  return s
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function getStringValue(value: ToolArgValue): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * Descriptive label for a tool call. Ported from
 * `desktop/src/components/ToolCallWithResponse.tsx:593` `getToolDescription`.
 * Falls back to `Title Case` + compact args for unknown tools.
 */
export function getToolDescription(
  rawToolName: string,
  rawArgs: unknown
): string | null {
  const args = (rawArgs ?? {}) as Record<string, ToolArgValue>;
  const toolName = extractToolName(rawToolName);

  switch (toolName) {
    case "text_editor":
      if (args.command === "write" && args.path) return `writing ${getStringValue(args.path)}`;
      if (args.command === "view" && args.path) return `reading ${getStringValue(args.path)}`;
      if (args.command === "str_replace" && args.path) return `editing ${getStringValue(args.path)}`;
      if (args.command && args.path) return `${getStringValue(args.command)} ${getStringValue(args.path)}`;
      break;
    case "shell":
      if (args.command) return `running ${getStringValue(args.command)}`;
      break;
    case "search":
      if (args.name) return `searching for "${getStringValue(args.name)}"`;
      if (args.mimeType) return `searching for ${getStringValue(args.mimeType)} files`;
      break;
    case "read": {
      if (args.uri) {
        const uri = getStringValue(args.uri);
        const fileId = uri.replace("gdrive:///", "");
        return `reading file ${fileId}`;
      }
      if (args.url) return `reading ${getStringValue(args.url)}`;
      break;
    }
    case "create_file":
      if (args.name) return `creating ${getStringValue(args.name)}`;
      break;
    case "update_file":
      if (args.fileId) return `updating file ${getStringValue(args.fileId)}`;
      break;
    case "sheets_tool": {
      if (args.operation && args.spreadsheetId) {
        return `${getStringValue(args.operation)} in sheet ${getStringValue(args.spreadsheetId)}`;
      }
      break;
    }
    case "docs_tool": {
      if (args.operation && args.documentId) {
        return `${getStringValue(args.operation)} in document ${getStringValue(args.documentId)}`;
      }
      break;
    }
    case "remember_memory":
      if (args.category && args.data) return `storing ${getStringValue(args.category)}: ${getStringValue(args.data)}`;
      break;
    case "retrieve_memories":
      if (args.category) return `retrieving ${getStringValue(args.category)} memories`;
      break;
    case "screen_capture":
      if (args.window_title) return `capturing window "${getStringValue(args.window_title)}"`;
      return "capturing screen";
    case "delegate": {
      if (args.instructions) {
        const instr = getStringValue(args.instructions);
        const truncated = instr.length > 80 ? instr.substring(0, 80) + "…" : instr;
        return `delegating: ${truncated}`;
      }
      if (args.source) return `delegating to ${getStringValue(args.source)}`;
      return "delegating task";
    }
    case "load": {
      if (args.source) return `loading ${getStringValue(args.source)}`;
      return "loading source";
    }
    case "final_output":
      return "final output";
    case "computer_control":
      return "poking around...";
    case "execute_typescript": {
      const toolGraph = args.tool_graph as unknown as ToolGraphNode[] | undefined;
      if (toolGraph && Array.isArray(toolGraph) && toolGraph.length > 0) {
        if (toolGraph.length === 1) return `${toolGraph[0].description}`;
        if (toolGraph.length === 2) return `${toolGraph[0].tool}, ${toolGraph[1].tool}`;
        return `${toolGraph.length} tools used`;
      }
      return "executing code";
    }
    // kawai-specific
    case "knowledge_search": {
      const q = args.query ?? args.q;
      if (typeof q === "string" && q.trim()) {
        const truncated = q.length > 60 ? q.slice(0, 60) + "…" : q;
        // mode-aware hint
        const mode = typeof args.mode === "string" ? ` · ${args.mode}` : "";
        return `searching knowledge: "${truncated}"${mode}`;
      }
      if (typeof args.mode === "string") return `searching knowledge (${args.mode})`;
      return "searching knowledge";
    }
    case "knowledge_add_to_session":
      if (Array.isArray(args.fileIds)) return `adding ${args.fileIds.length} file(s) to session`;
      return "adding to session";
    case "office_index_file":
      return "indexing document";
    case "office_read_file":
      if (args.fileId) return `reading ${getStringValue(args.fileId as ToolArgValue)}`;
      return "reading document";
    case "knowledge_list":
      return "listing knowledge";
    case "knowledge_import_youtube":
      if (args.url) return `importing ${getStringValue(args.url as ToolArgValue)}`;
      return "importing YouTube";
    default:
      break;
  }

  // Generic fallback — ensures every MCP tool gets a label
  const toolDisplayName = snakeToTitleCase(toolName);
  const entries = Object.entries(args);
  if (entries.length === 0) return toolDisplayName;
  if (entries.length === 1) {
    const [key, value] = entries[0];
    const stringValue = getStringValue(value);
    // truncate long single values
    const truncated = stringValue.length > 50 ? stringValue.slice(0, 50) + "…" : stringValue;
    return `${toolDisplayName} ${key}: ${truncated}`;
  }
  const keys = entries.map(([k]) => k).join(", ");
  return `${toolDisplayName} ${keys}`;
}

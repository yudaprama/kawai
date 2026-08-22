/**
 * Port of `desktop/src/utils/htmlSecurity.ts:13`.
 * Wraps dangerous raw HTML outside fenced code in `html` code blocks so it
 * displays safely instead of executing / polluting layout.
 */
export function containsHTML(str: string): boolean {
  const withoutCodeBlocks = str.replace(/```[\s\S]*?```/g, "").replace(/`[^`]*`/g, "");
  const commentRegex = /<!--[\s\S]*?-->/;
  if (commentRegex.test(withoutCodeBlocks)) return true;
  const dangerousHTMLRegex =
    /<(script|style|iframe|object|embed|form|input|button|link|meta|base|br|hr|img|div|span|p|h[1-6]|a|strong|em|b|i|u|s|pre|code|blockquote|section|article|header|footer|nav|aside|main|table|tr|td|th|ul|ol|li)(?:\s[^>]*)?(?:\s*\/?>|>[^<]*<\/\1>)/i;
  return dangerousHTMLRegex.test(withoutCodeBlocks);
}

export function wrapHTMLInCodeBlock(content: string): string {
  const lines = content.split("\n");
  let insideCodeBlock = false;
  const processed = lines.map((line) => {
    if (line.trim().startsWith("```")) {
      insideCodeBlock = !insideCodeBlock;
      return line;
    }
    if (insideCodeBlock) return line;
    if (containsHTML(line)) return `\`\`\`html\n${line}\n\`\`\``;
    return line;
  });
  return processed.join("\n");
}

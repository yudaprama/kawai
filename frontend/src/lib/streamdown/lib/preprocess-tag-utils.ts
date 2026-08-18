/**
 * Shared utilities for preprocessing custom tags in markdown.
 */

/**
 * Regex pattern for matching custom tags with their content.
 * Matches opening tag, content, and closing tag.
 */
export const createCustomTagPattern = (tagName: string): RegExp =>
  new RegExp(`(<${tagName}(?=[\\s>/])[^>]*>)([\\s\\S]*?)(</${tagName}\\s*>)`, "gi");

/**
 * Iterates over all occurrences of custom tags in markdown and applies a transformation
 * to their content.
 *
 * @param markdown - The markdown string to process
 * @param tagNames - Array of custom tag names to process
 * @param transform - Function that receives (openTag, content, closeTag) and returns the replacement
 * @returns The processed markdown string
 */
export const processCustomTags = (
  markdown: string,
  tagNames: string[],
  transform: (open: string, content: string, close: string) => string
): string => {
  if (!tagNames.length) {
    return markdown;
  }

  let result = markdown;

  for (const tagName of tagNames) {
    const pattern = createCustomTagPattern(tagName);

    result = result.replace(pattern, (_match, open: string, content: string, close: string) => {
      return transform(open, content, close);
    });
  }

  return result;
};
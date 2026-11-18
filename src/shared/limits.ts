/**
 * Content limits shared by the tool schemas, the MCP handlers, the REST
 * validators and the sanitizer, so the declared limit and the enforced one
 * cannot drift apart (field report 8aeaee56 M8).
 */

/** Maximum characters in one stored text: a message body or one observation string. */
export const MAX_CONTENT_CHARS = 10000;

/**
 * Length in Unicode code points, the unit JSON Schema maxLength uses: an emoji
 * counts as one character, not as two UTF-16 units.
 */
export function codePointLength(text: string): number {
  let n = 0;
  for (const _ of text) n++;
  return n;
}

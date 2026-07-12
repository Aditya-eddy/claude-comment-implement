/** Pure text helpers (no vscode dependency) so they're unit-testable in plain Node. */

/** Trim and strip a surrounding ```lang … ``` markdown fence if the model added one. */
export function cleanResult(s: string): string {
  if (!s) {
    return '';
  }
  let t = s.trim();
  const fence = t.match(/^```[\w-]*\n([\s\S]*?)\n?```$/);
  if (fence) {
    t = fence[1];
  }
  return t.replace(/[ \t]+$/gm, '').replace(/\s+$/, '');
}

/** Prepend `indent` to every non-empty line so generated code aligns with the comment. */
export function reindent(code: string, indent: string): string {
  if (!indent) {
    return code;
  }
  return code
    .split('\n')
    .map((line) => (line.trim().length ? indent + line : line))
    .join('\n');
}

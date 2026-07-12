import * as vscode from 'vscode';

export interface Marker {
  line: number;
  indent: string;
  instruction: string;
  range: vscode.Range;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build the marker regex for a given keyword. Matches a line that is a comment
 * (leader //, #, --, or ;) followed by the marker keyword and an instruction:
 *   //claude do the thing      #claude: do it     -- claude do it
 * Group 1 = leading indentation, group 2 = instruction text.
 */
export function markerRegex(marker: string): RegExp {
  const kw = escapeRegExp(marker);
  return new RegExp(`^(\\s*)(?://+|#+|--+|;+)\\s*${kw}\\b[:\\-\\s]*(.*)$`, 'i');
}

/** Scan a document for marker comment lines that carry a non-empty instruction. */
export function findMarkers(document: vscode.TextDocument, marker: string): Marker[] {
  const re = markerRegex(marker);
  const out: Marker[] = [];
  for (let line = 0; line < document.lineCount; line++) {
    const text = document.lineAt(line).text;
    const m = re.exec(text);
    if (!m) {
      continue;
    }
    const instruction = (m[2] ?? '').trim();
    if (!instruction) {
      continue; // bare marker with no instruction — nothing to implement
    }
    out.push({
      line,
      indent: m[1] ?? '',
      instruction,
      range: new vscode.Range(line, 0, line, text.length)
    });
  }
  return out;
}

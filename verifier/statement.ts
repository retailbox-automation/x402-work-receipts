/**
 * What the chain proves, and what it does not.
 *
 * The command prints this on every run, pass or fail, because a proof whose
 * limits are not stated invites the reader to over-read it. The wording is not
 * kept here: it lives in `docs/schemas/README.md`, which took it from the
 * source protocol spec, and is read from that file at run time. A copy in the
 * code would be a second source that quietly drifts — and a claim about
 * evidence that drifts is worse than no claim.
 */
import { readFileSync } from "node:fs";

/** Where the wording lives, relative to the repository root. */
export const STATEMENT_SOURCE = "docs/schemas/README.md";

/** The paragraph is found by its opening words, not by a line number. */
const MARKER = "What the chain proves";

/** Read once per process; the file does not change under a running command. */
let cached: string | undefined;

/**
 * The published statement, as one paragraph of plain text.
 *
 * @returns The wording from {@link STATEMENT_SOURCE}
 * @throws When the file or its statement paragraph is missing
 */
export function statementText(): string {
  if (cached === undefined) {
    const source = new URL(`../${STATEMENT_SOURCE}`, import.meta.url);
    let markdown: string;
    try {
      markdown = readFileSync(source, "utf8");
    } catch (error) {
      throw new Error(
        `Could not read the statement source ${STATEMENT_SOURCE}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    cached = extractStatement(markdown);
  }
  return cached;
}

/**
 * Pulls the statement paragraph out of the schemas README.
 *
 * Markdown emphasis and code ticks are dropped — they are formatting, not
 * wording — and nothing else is touched.
 *
 * @param markdown - Contents of the README
 * @returns The paragraph as plain text
 * @throws When the README carries no statement paragraph
 */
export function extractStatement(markdown: string): string {
  const lines = markdown.split("\n");
  const start = lines.findIndex(line => line.startsWith(MARKER));
  if (start === -1) {
    throw new Error(
      `Could not find the statement paragraph ("${MARKER}…") in ${STATEMENT_SOURCE}`,
    );
  }

  const paragraph: string[] = [];
  for (let index = start; index < lines.length && lines[index].trim() !== ""; index++) {
    paragraph.push(lines[index].trim());
  }

  return paragraph.join(" ").replace(/[`*]/g, "").trim();
}

/**
 * The statement wrapped for a terminal.
 *
 * @param width - Maximum line length; 88 by default
 * @returns The statement, hard-wrapped, no line longer than `width`
 */
export function renderStatement(width = 88): string {
  return wrap(statementText(), Math.max(20, width));
}

/**
 * Hard-wraps text on word boundaries.
 *
 * @param text - Text to wrap
 * @param width - Maximum line length
 * @returns The wrapped text
 */
function wrap(text: string, width: number): string {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (line === "") {
      line = word;
    } else if (`${line} ${word}`.length <= width) {
      line = `${line} ${word}`;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line !== "") {
    lines.push(line);
  }
  return lines.join("\n");
}

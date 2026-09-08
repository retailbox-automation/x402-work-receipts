/**
 * The verifier prints what the chain proves and what it does not, and that
 * wording has exactly one home: `docs/schemas/README.md`. A copy in the code
 * would drift, and a claim that drifts is worse than no claim.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  STATEMENT_SOURCE,
  extractStatement,
  renderStatement,
  statementText,
} from "../../verifier/statement";

/** The published wording, read here independently of the module under test. */
function sourceParagraph(): string {
  const markdown = readFileSync(
    new URL(`../../${STATEMENT_SOURCE}`, import.meta.url),
    "utf8",
  );
  const line = markdown
    .split("\n")
    .find(candidate => candidate.startsWith("What the chain proves"));
  if (!line) {
    throw new Error(`No statement paragraph in ${STATEMENT_SOURCE}`);
  }
  return line.replace(/[`*]/g, "").trim();
}

describe("the statement", () => {
  it("is the published wording, not a copy of it", () => {
    expect(statementText()).toBe(sourceParagraph());
  });

  it("says what the chain does not prove", () => {
    expect(statementText()).toContain("does not prove");
    expect(statementText()).toContain("the quality or the fact of the work");
  });

  it("accounts for the payment profile", () => {
    expect(statementText()).toContain("intake and balance transfers exist on the ledger");
  });

  it("renders without markdown for a terminal, wrapped to the given width", () => {
    const rendered = renderStatement(72);
    expect(rendered).not.toMatch(/[`*]/);
    expect(rendered).toContain("What the chain proves");
    for (const line of rendered.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(72);
    }
  });

  it("refuses to invent a statement when the source section is gone", () => {
    expect(() => extractStatement("# Schemas\n\nNothing here.\n")).toThrow(/statement/i);
  });
});

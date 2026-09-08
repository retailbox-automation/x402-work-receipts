/**
 * The two copied schemas may not change without somebody saying so.
 *
 * `mandate.v1.schema.json` and `receipt.v1.schema.json` are byte-identical
 * copies of the source protocol. Every hash this system anchors, and every
 * receipt a stranger later verifies, is only meaningful while both parties
 * validate against the same bytes — so an edit here is a protocol change, not a
 * file change, and it must be deliberate.
 *
 * The digests live in `docs/schemas/README.md`, not in this file, for the same
 * reason the verifier reads its statement from that README: a constant kept in
 * the test would be updated by whoever changed the schema, in the same reflex,
 * and would document nothing. Recorded next to the provenance table, the digest
 * is a claim a reader can check.
 *
 * `payment.v1.schema.json` is generated rather than copied, so it is checked
 * differently: regenerate it in a scratch directory and require the committed
 * file to match, which catches a profile edited by hand.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

/** The schemas directory, resolved from this file so the suite is directory-independent. */
const SCHEMAS = fileURLToPath(new URL("../../docs/schemas/", import.meta.url));

/** Where the digests are recorded. */
const README = join(SCHEMAS, "README.md");

/** The copies that must not drift. */
const COPIED = ["mandate.v1.schema.json", "receipt.v1.schema.json"] as const;

/** The generated profile. */
const GENERATED = "payment.v1.schema.json";

/** The generator. */
const BUILDER = "build_payment_profile.py";

const scratch: string[] = [];

afterAll(() => {
  for (const directory of scratch) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * Reads the digests recorded in the README's provenance table.
 *
 * @returns File name to sha256, lowercase hex
 */
function recordedDigests(): Map<string, string> {
  const digests = new Map<string, string>();
  for (const line of readFileSync(README, "utf8").split("\n")) {
    const name = COPIED.find(file => line.includes(`\`${file}\``));
    const digest = /\b([0-9a-f]{64})\b/.exec(line);
    if (name && digest) {
      digests.set(name, digest[1] as string);
    }
  }
  return digests;
}

/**
 * The sha256 of a file, as bytes rather than as text: a line ending is a change.
 *
 * @param path - File to hash
 * @returns Lowercase hex digest
 */
function digestOf(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Whether `python3` can be run here.
 *
 * @returns True when the interpreter answers
 */
function hasPython(): boolean {
  try {
    execFileSync("python3", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("schema drift", () => {
  it("records a digest for every copied schema", () => {
    expect([...recordedDigests().keys()].sort()).toEqual([...COPIED].sort());
  });

  it.each(COPIED)("%s still matches the digest recorded in the README", file => {
    expect(digestOf(join(SCHEMAS, file))).toBe(recordedDigests().get(file));
  });

  it.runIf(hasPython())("payment.v1 is exactly what the generator produces", () => {
    const directory = mkdtempSync(join(tmpdir(), "schema-drift-"));
    scratch.push(directory);
    for (const file of ["receipt.v1.schema.json", BUILDER]) {
      copyFileSync(join(SCHEMAS, file), join(directory, file));
    }

    execFileSync("python3", [join(directory, BUILDER)], { stdio: "ignore" });

    expect(readFileSync(join(directory, GENERATED), "utf8")).toBe(
      readFileSync(join(SCHEMAS, GENERATED), "utf8"),
    );
  });
});

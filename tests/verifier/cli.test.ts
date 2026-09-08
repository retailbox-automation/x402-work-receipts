/**
 * End to end through the command, offline.
 *
 * The mirror reads are injected, so these tests exercise the real argument
 * handling, the real checks and the real exit codes against recorded data —
 * including the four tampered receipts, each of which must fail the check it
 * was built to fail.
 */
import { describe, expect, it } from "vitest";
import type { AnchorEntry } from "../../anchor/records";
import { toMirrorTxId } from "../../anchor/records";
import {
  CHECK_ANCHOR_SEQUENCE,
  CHECK_MANDATE_LINK,
  CHECK_PAYMENTS,
  CHECK_RECEIPT_ANCHOR,
  CHECK_SIGNATURE,
} from "../../verifier/checks";
import { EXIT_ERROR, EXIT_FAILED, EXIT_OK, renderTable, verify } from "../../verifier/cli";
import type { VerifyDeps } from "../../verifier/cli";
import { MirrorError } from "../../verifier/mirror";
import type { MirrorTransaction } from "../../verifier/mirror";
import {
  GOLDEN_TOPIC,
  type TopicMessagePage,
  anchorsFrom,
  fixture,
  goldenTopicPage,
  goldenTransactions,
} from "./helpers";

/** Absolute path of a fixture, the way a user would pass it on the command line. */
function path(relativePath: string): string {
  return new URL(relativePath, import.meta.url).pathname;
}

/**
 * Mirror readers backed by the recorded snapshot.
 *
 * @param page - Topic page to serve; the golden one by default
 * @returns Injectable dependencies
 */
function offlineDeps(page: TopicMessagePage = goldenTopicPage()): VerifyDeps {
  const anchors = anchorsFrom(page);
  const transactions = goldenTransactions();
  return {
    readAnchors: async (): Promise<AnchorEntry[]> => anchors,
    readTransaction: async (id: string): Promise<MirrorTransaction | null> =>
      transactions.get(toMirrorTxId(id)) ?? null,
  };
}

/**
 * Names of the checks that failed.
 *
 * @param checks - Results of a run
 * @returns Failing check names
 */
function failures(checks: { name: string; ok: boolean }[]): string[] {
  return checks.filter(check => !check.ok).map(check => check.name);
}

describe("verify on the golden run", () => {
  it("passes every check and exits 0", async () => {
    const result = await verify(
      {
        topicId: GOLDEN_TOPIC,
        receiptPath: path("./golden/receipt.json"),
        mandatePath: path("./golden/mandate.json"),
      },
      offlineDeps(),
    );
    expect(failures(result.checks)).toEqual([]);
    expect(result.code).toBe(EXIT_OK);
  });

  it("passes without the optional mandate file", async () => {
    const result = await verify(
      { topicId: GOLDEN_TOPIC, receiptPath: path("./golden/receipt.json") },
      offlineDeps(),
    );
    expect(result.code).toBe(EXIT_OK);
  });

  it("prints a table of checks and then the statement", async () => {
    const result = await verify(
      { topicId: GOLDEN_TOPIC, receiptPath: path("./golden/receipt.json") },
      offlineDeps(),
    );
    expect(result.output).toContain(CHECK_SIGNATURE);
    expect(result.output).toContain(CHECK_PAYMENTS);
    expect(result.output).toContain("PASS");
    expect(result.output).toContain("What the chain proves");
    expect(result.output.indexOf(CHECK_RECEIPT_ANCHOR)).toBeLessThan(
      result.output.indexOf("What the chain proves"),
    );
  });

  it("renders a readable table", () => {
    const table = renderTable([
      { name: "receipt signature", ok: true, detail: "signed by 9957…" },
      { name: "payments on ledger", ok: false, detail: "payee never credited" },
    ]);
    expect(table).toMatch(/PASS.*receipt signature/s);
    expect(table).toMatch(/FAIL.*payments on ledger/s);
    expect(table).toContain("payee never credited");
  });
});

describe("tampered receipts", () => {
  /**
   * Runs a tampered fixture and returns which checks failed.
   *
   * @param file - Fixture file name under `tampered/`
   * @returns Exit code and failing check names
   */
  async function run(file: string): Promise<{ code: number; failed: string[] }> {
    const result = await verify(
      {
        topicId: GOLDEN_TOPIC,
        receiptPath: path(`./tampered/${file}`),
        mandatePath: path("./golden/mandate.json"),
      },
      offlineDeps(),
    );
    return { code: result.code, failed: failures(result.checks) };
  }

  it("catches an edited mandate hash on check 2", async () => {
    const { code, failed } = await run("edited-receipt-hash.json");
    expect(failed).toContain(CHECK_MANDATE_LINK);
    // Editing any byte of the receipt also breaks the signature and the
    // anchored receipt hash; both are recorded here so the collateral is
    // documented rather than surprising.
    expect(failed).toEqual([CHECK_SIGNATURE, CHECK_MANDATE_LINK, CHECK_RECEIPT_ANCHOR]);
    expect(code).toBe(EXIT_FAILED);
  });

  it("catches swapped payment transaction ids on check 4", async () => {
    const { code, failed } = await run("swapped-tx-id.json");
    expect(failed).toContain(CHECK_PAYMENTS);
    expect(failed).toEqual([CHECK_SIGNATURE, CHECK_PAYMENTS, CHECK_RECEIPT_ANCHOR]);
    expect(code).toBe(EXIT_FAILED);
  });

  it("catches a payee that was never credited on check 4", async () => {
    const { code, failed } = await run("wrong-payee.json");
    expect(failed).toContain(CHECK_PAYMENTS);
    expect(failed).toEqual([CHECK_SIGNATURE, CHECK_PAYMENTS, CHECK_RECEIPT_ANCHOR]);
    expect(code).toBe(EXIT_FAILED);
  });

  it("catches a missing anchor on check 3, and only there", async () => {
    // The receipt here is the untouched golden one: what was tampered with is
    // the public record, so no other check has any reason to move.
    const page = fixture<TopicMessagePage>("./tampered/missing-anchor/topic-messages.json");
    const result = await verify(
      {
        topicId: GOLDEN_TOPIC,
        receiptPath: path("./golden/receipt.json"),
        mandatePath: path("./golden/mandate.json"),
      },
      offlineDeps(page),
    );
    expect(failures(result.checks)).toEqual([CHECK_ANCHOR_SEQUENCE]);
    expect(result.code).toBe(EXIT_FAILED);
  });
});

describe("when the check cannot be completed", () => {
  it("exits 2 when the mirror node cannot be read", async () => {
    const result = await verify(
      { topicId: GOLDEN_TOPIC, receiptPath: path("./golden/receipt.json") },
      {
        readAnchors: async () => {
          throw new MirrorError("mirror node unreachable");
        },
        readTransaction: async () => null,
      },
    );
    expect(result.code).toBe(EXIT_ERROR);
    expect(result.output).toMatch(/could not/i);
  });

  it("exits 2 when the receipt file is not there", async () => {
    const result = await verify(
      { topicId: GOLDEN_TOPIC, receiptPath: path("./golden/nope.json") },
      offlineDeps(),
    );
    expect(result.code).toBe(EXIT_ERROR);
  });

  it("names the work order, not the receipt, when the mandate file is wrong", async () => {
    const result = await verify(
      {
        topicId: GOLDEN_TOPIC,
        receiptPath: path("./golden/receipt.json"),
        mandatePath: path("./golden/receipt.json"),
      },
      offlineDeps(),
    );
    expect(result.code).toBe(EXIT_ERROR);
    expect(result.output).toMatch(/work order/i);
  });

  it("exits 2 when the receipt is not a signed receipt envelope", async () => {
    const result = await verify(
      { topicId: GOLDEN_TOPIC, receiptPath: path("./golden/mandate.json") },
      offlineDeps(),
    );
    expect(result.code).toBe(EXIT_ERROR);
    expect(result.output).toMatch(/receipt/i);
  });
});

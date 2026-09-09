/**
 * The optional retainer check, against a real order with a fabricated retainer
 * bolted onto it — and against every way that retainer can be wrong.
 *
 * The order, the receipt and the twelve anchors are the recorded golden run;
 * the retainer's two anchors and the two mirror-node answers are built here,
 * because no golden run has a retainer yet. What matters is that each mutation
 * moves exactly one verdict: the check takes data and fetches nothing, so a
 * test can change one number and watch the answer change with it.
 */
import { describe, expect, it } from "vitest";
import type { AnchorEntry } from "../../anchor/records";
import { buildRetainerAnchor, type RetainerFacts } from "../../retainer/records";
import {
  CHECK_ANCHOR_SEQUENCE,
  CHECK_NAMES,
  CHECK_RETAINER,
  anchorsForMandate,
  checkAnchorSequence,
  runChecks,
} from "../../verifier/checks";
import type { VerificationInput } from "../../verifier/checks";
import type { MirrorSchedule, MirrorTransaction } from "../../verifier/mirror";
import { type RetainerEvidence, checkRetainer, retainerLookups } from "../../verifier/retainer";
import { EXIT_FAILED, EXIT_OK, verify } from "../../verifier/cli";
import type { VerifyDeps } from "../../verifier/cli";
import { toMirrorTxId } from "../../anchor/records";
import { GOLDEN_TOPIC, anchorsFrom, goldenMandate, goldenReceipt, goldenTransactions } from "./helpers";

/** The golden order's own delivered anchor: everything a release must come after. */
const DELIVERED_AT = "1788894531.828350205";

/** Consensus time of the released transfer — after delivery, as a retainer must be. */
const RELEASED_AT = "1788894560.500000000";

/** The schedule and the transfer it ran. */
const SCHEDULE_ID = "0.0.10440150";
const RELEASE_TX = "0.0.10365982-1788894519-900000000";
const TINYBARS = 1_000_000;

const PAYER = "0.0.10365982";
const PAYEE = "0.0.10365984";

/** The facts both anchors are hashed over. */
function facts(overrides: Partial<RetainerFacts> = {}): RetainerFacts {
  return {
    network: "hedera:testnet",
    payer: PAYER,
    payee: PAYEE,
    tinybars: TINYBARS,
    schedule_id: SCHEDULE_ID,
    transaction_id: RELEASE_TX,
    ...overrides,
  };
}

/**
 * The two retainer anchors, placed on the topic where they belong: the
 * authorisation early in the order, the release after the delivery.
 *
 * @param overrides - Facts to change before hashing, so a test can anchor a lie
 * @returns The anchors, with consensus positions
 */
function retainerAnchorEntries(overrides: Partial<RetainerFacts> = {}): AnchorEntry[] {
  const mandateId = goldenReceipt().data.mandate_id;
  const anchored = facts(overrides);
  return [
    {
      ...buildRetainerAnchor("scheduled", mandateId, anchored, "2026-09-08T10:28:40.000Z"),
      seq: 200,
      consensus_ts: "1788894520.100000000",
    },
    {
      ...buildRetainerAnchor("released", mandateId, anchored, "2026-09-08T10:29:21.000Z"),
      seq: 201,
      consensus_ts: "1788894561.000000000",
    },
  ];
}

/** The schedule as the mirror node would return it after a release. */
function schedule(overrides: Partial<MirrorSchedule> = {}): MirrorSchedule {
  return {
    schedule_id: SCHEDULE_ID,
    creator_account_id: PAYER,
    payer_account_id: PAYEE,
    consensus_timestamp: "1788894519.900000000",
    executed_timestamp: RELEASED_AT,
    expiration_time: "1788896320.000000000",
    wait_for_expiry: false,
    deleted: false,
    ...overrides,
  };
}

/** The transfer the schedule executed, as the mirror node would return it. */
function release(overrides: Partial<MirrorTransaction> = {}): MirrorTransaction {
  return {
    transaction_id: RELEASE_TX,
    result: "SUCCESS",
    name: "CRYPTOTRANSFER",
    scheduled: true,
    consensus_timestamp: RELEASED_AT,
    transfers: [
      { account: PAYER, amount: -TINYBARS },
      { account: PAYEE, amount: TINYBARS },
    ],
    ...overrides,
  };
}

/**
 * A verification input for the golden order with a retainer attached.
 *
 * @param options - Which anchors to attach and what the mirror node says
 * @returns The input, ready for a check
 */
function input(options: {
  anchors?: AnchorEntry[];
  evidence?: RetainerEvidence | undefined;
} = {}): VerificationInput {
  const extra = options.anchors ?? retainerAnchorEntries();
  return {
    topicId: GOLDEN_TOPIC,
    receipt: goldenReceipt(),
    mandate: goldenMandate(),
    anchors: [...anchorsFrom(), ...extra],
    transactions: goldenTransactions(),
    retainer:
      "evidence" in options ? options.evidence : { schedule: schedule(), release: release() },
  };
}

/**
 * Runs the check the way `runChecks` does.
 *
 * @param verification - The input
 * @returns The verdict
 */
function verdict(verification: VerificationInput) {
  return checkRetainer(
    verification,
    anchorsForMandate(verification.anchors, verification.receipt.data.mandate_id),
  );
}

describe("an order with no retainer", () => {
  it("is not applicable rather than failed", () => {
    const result = verdict({
      topicId: GOLDEN_TOPIC,
      receipt: goldenReceipt(),
      anchors: anchorsFrom(),
      transactions: goldenTransactions(),
    });
    expect(result.ok).toBe(true);
    expect(result.detail).toMatch(/not applicable/);
  });

  it("still runs as the sixth check of the golden run, and every check passes", () => {
    const results = runChecks({
      topicId: GOLDEN_TOPIC,
      receipt: goldenReceipt(),
      mandate: goldenMandate(),
      anchors: anchorsFrom(),
      transactions: goldenTransactions(),
    });
    expect(results.map(result => result.name)).toEqual([...CHECK_NAMES]);
    expect(results.filter(result => !result.ok)).toEqual([]);
  });

  it("asks the mirror node for nothing", () => {
    expect(retainerLookups(anchorsFrom())).toEqual({
      scheduleId: undefined,
      releaseTransactionId: undefined,
    });
  });
});

describe("a retainer that holds up", () => {
  it("passes, naming the amount, the schedule and when it was released", () => {
    const result = verdict(input());
    expect(result.ok).toBe(true);
    expect(result.detail).toContain(String(TINYBARS));
    expect(result.detail).toContain(SCHEDULE_ID);
    expect(result.detail).toContain(RELEASED_AT);
  });

  it("does not disturb the required anchor sequence", () => {
    const verification = input();
    expect(checkAnchorSequence(verification)).toMatchObject({
      name: CHECK_ANCHOR_SEQUENCE,
      ok: true,
    });
    expect(runChecks(verification).filter(result => !result.ok)).toEqual([]);
  });

  it("names the schedule and the transfer a verifier has to fetch", () => {
    const verification = input();
    const mine = anchorsForMandate(verification.anchors, verification.receipt.data.mandate_id);
    expect(retainerLookups(mine)).toEqual({
      scheduleId: SCHEDULE_ID,
      releaseTransactionId: RELEASE_TX,
    });
  });

  it("is still pending, not failed, before the contractor releases it", () => {
    const [scheduled] = retainerAnchorEntries();
    const result = verdict(
      input({
        anchors: [scheduled],
        evidence: { schedule: schedule({ executed_timestamp: null }), release: null },
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.detail).toMatch(/still pending/);
  });
});

describe("a retainer that does not hold up", () => {
  /**
   * Asserts the check fails for the stated reason.
   *
   * @param verification - The input
   * @param reason - Pattern the detail must match
   */
  function expectFailure(verification: VerificationInput, reason: RegExp): void {
    const result = verdict(verification);
    expect(result.name).toBe(CHECK_RETAINER);
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(reason);
  }

  it("fails when the release is anchored without the authorisation it releases", () => {
    const [, released] = retainerAnchorEntries();
    expectFailure(input({ anchors: [released] }), /stands alone/);
  });

  it("fails when the anchors are on the topic but were never resolved", () => {
    expectFailure(input({ evidence: undefined }), /not resolved against the mirror node/);
  });

  it("fails when the schedule is not on the mirror node", () => {
    expectFailure(
      input({ evidence: { schedule: null, release: release() } }),
      /is not on the mirror node/,
    );
  });

  it("fails when somebody other than the receipt's payer authorised it", () => {
    expectFailure(
      input({ evidence: { schedule: schedule({ creator_account_id: "0.0.999" }), release: release() } }),
      /authorised by 0\.0\.999/,
    );
  });

  it("fails when the schedule was deleted", () => {
    expectFailure(
      input({ evidence: { schedule: schedule({ deleted: true }), release: release() } }),
      /deleted/,
    );
  });

  it("fails when the mirror node answers with a different schedule", () => {
    expectFailure(
      input({ evidence: { schedule: schedule({ schedule_id: "0.0.1" }), release: release() } }),
      /returned schedule 0\.0\.1/,
    );
  });

  it("fails when the released transfer is not on the ledger", () => {
    expectFailure(
      input({ evidence: { schedule: schedule(), release: null } }),
      /is not on the mirror node/,
    );
  });

  it("fails when the anchored transaction is the ScheduleCreate, not the transfer it ran", () => {
    expectFailure(
      input({ evidence: { schedule: schedule(), release: release({ scheduled: false }) } }),
      /not the transfer a schedule executed/,
    );
  });

  it("fails when the transfer did not succeed", () => {
    expectFailure(
      input({ evidence: { schedule: schedule(), release: release({ result: "INSUFFICIENT_ACCOUNT_BALANCE" }) } }),
      /ended as INSUFFICIENT_ACCOUNT_BALANCE/,
    );
  });

  it("fails when the money went to somebody else", () => {
    expectFailure(
      input({
        evidence: {
          schedule: schedule(),
          release: release({
            transfers: [
              { account: PAYER, amount: -TINYBARS },
              { account: "0.0.777", amount: TINYBARS },
            ],
          }),
        },
      }),
      /credits nothing to 0\.0\.10365984/,
    );
  });

  it("fails when the payer was not debited what the payee was credited", () => {
    expectFailure(
      input({
        evidence: {
          schedule: schedule(),
          release: release({
            transfers: [
              { account: PAYER, amount: -500_000 },
              { account: PAYEE, amount: TINYBARS },
            ],
          }),
        },
      }),
      /does not debit 1000000 tinybars/,
    );
  });

  it("fails when the anchor claims an amount the ledger does not show", () => {
    // The anchors are hashed over 2 000 000 tinybars; the transfer moved half of it.
    expectFailure(input({ anchors: retainerAnchorEntries({ tinybars: 2_000_000 }) }), /does not cover/);
  });

  it("fails when the schedule executed at a different instant from the anchored transfer", () => {
    expectFailure(
      input({
        evidence: { schedule: schedule({ executed_timestamp: "1788894599.000000000" }), release: release() },
      }),
      /but the anchored transfer reached consensus at/,
    );
  });

  it("fails when the retainer was released at or before the delivery it pays for", () => {
    const early = "1788894530.000000000";
    expectFailure(
      input({
        evidence: {
          schedule: schedule({ executed_timestamp: early }),
          release: release({ consensus_timestamp: early }),
        },
      }),
      new RegExp(`released at ${early}, at or before the delivery anchored at ${DELIVERED_AT}`),
    );
  });

  it("fails when the schedule executed but the topic holds no release", () => {
    const [scheduled] = retainerAnchorEntries();
    expectFailure(
      input({ anchors: [scheduled], evidence: { schedule: schedule(), release: null } }),
      /executed at .* but the topic holds no retainer_released anchor/,
    );
  });

  it("fails when the release was anchored before the authorisation", () => {
    const [scheduled, released] = retainerAnchorEntries();
    expectFailure(
      input({
        anchors: [
          { ...scheduled, consensus_ts: "1788894570.000000000" },
          { ...released, consensus_ts: "1788894561.000000000" },
        ],
      }),
      /anchored no later than the authorisation/,
    );
  });

  it("fails when the authorisation anchor names something that is not a schedule", () => {
    const [scheduled, released] = retainerAnchorEntries();
    expectFailure(
      input({ anchors: [{ ...scheduled, ref: RELEASE_TX }, released] }),
      /is not a schedule id/,
    );
  });
});

describe("the verify command with a retainer on the topic", () => {
  /** Absolute path of a fixture, the way a user would pass it on the command line. */
  function path(relativePath: string): string {
    return new URL(relativePath, import.meta.url).pathname;
  }

  /**
   * Offline readers, including the two the retainer needs.
   *
   * @param evidence - What the mirror node should say about the retainer
   * @param extra - Retainer anchors to put on the topic
   * @returns Injectable dependencies
   */
  function deps(evidence: RetainerEvidence, extra: AnchorEntry[]): VerifyDeps {
    const anchors = [...anchorsFrom(), ...extra];
    const transactions = goldenTransactions();
    return {
      readAnchors: async () => anchors,
      readTransaction: async id => transactions.get(toMirrorTxId(id)) ?? null,
      readSchedule: async id => (id === SCHEDULE_ID ? evidence.schedule : null),
      readScheduledTransaction: async id => (id === RELEASE_TX ? evidence.release : null),
    };
  }

  it("reads the schedule and the transfer, and exits 0", async () => {
    const result = await verify(
      {
        topicId: GOLDEN_TOPIC,
        receiptPath: path("./golden/receipt.json"),
        mandatePath: path("./golden/mandate.json"),
      },
      deps({ schedule: schedule(), release: release() }, retainerAnchorEntries()),
    );
    expect(result.checks.filter(check => !check.ok)).toEqual([]);
    expect(result.code).toBe(EXIT_OK);
    expect(result.output).toContain(CHECK_RETAINER);
  });

  it("exits 1 when the anchored retainer is not the one the ledger shows", async () => {
    const result = await verify(
      { topicId: GOLDEN_TOPIC, receiptPath: path("./golden/receipt.json") },
      deps({ schedule: schedule(), release: release() }, retainerAnchorEntries({ tinybars: 7 })),
    );
    expect(result.checks.filter(check => !check.ok).map(check => check.name)).toEqual([CHECK_RETAINER]);
    expect(result.code).toBe(EXIT_FAILED);
  });

  it("does not ask for a schedule when the order has no retainer", async () => {
    const asked: string[] = [];
    const transactions = goldenTransactions();
    const result = await verify(
      { topicId: GOLDEN_TOPIC, receiptPath: path("./golden/receipt.json") },
      {
        readAnchors: async () => anchorsFrom(),
        readTransaction: async id => transactions.get(toMirrorTxId(id)) ?? null,
        readSchedule: async id => {
          asked.push(id);
          return null;
        },
        readScheduledTransaction: async () => null,
      },
    );
    expect(asked).toEqual([]);
    expect(result.code).toBe(EXIT_OK);
  });
});

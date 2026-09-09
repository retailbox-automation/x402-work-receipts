/**
 * The optional sixth check: was a retainer really held on the ledger, and did
 * the contractor only release it after delivering?
 *
 * Most orders in this protocol have no retainer, so this check is optional by
 * construction: an order whose topic carries no `retainer_*` anchor is not
 * failed, it is reported as not applicable. The five required checks are
 * untouched, and `EXPECTED_STEPS` still describes the same six anchors.
 *
 * When a retainer *is* anchored, the check is strict, because the anchors alone
 * are a claim. It reads the schedule entity and the transfer it executed from
 * the public mirror node, confirms that the customer named on the receipt
 * created the authorisation, that the transfer moved the anchored amount
 * between the two accounts the receipt names, that the anchored hashes cover
 * exactly those facts — and that the release reached consensus *after* the
 * `delivered` anchor, which is the only thing that makes it a retainer released
 * for work rather than a payment that happened to be scheduled.
 *
 * Like the rest of the verifier this file holds no keys, calls neither party
 * and cannot write anything.
 */
import { type AnchorEntry, compareConsensus, isScheduleId, toMirrorTxId } from "../anchor/records.js";
import { type RetainerFacts, retainerAnchorHash } from "../retainer/records.js";
import type { CheckResult, VerificationInput } from "./checks.js";
import type { MirrorSchedule, MirrorTransaction } from "./mirror.js";

/** Check 6: the retainer, when the order has one. */
export const CHECK_RETAINER = "retainer on ledger";

/** What the mirror node said about the retainer this order anchored. */
export type RetainerEvidence = {
  /** The schedule entity named by the `retainer_scheduled` anchor. */
  schedule: MirrorSchedule | null;
  /** The transfer named by the `retainer_released` anchor, if it has run. */
  release: MirrorTransaction | null;
};

/** The retainer anchors of one order. */
export type RetainerAnchors = {
  scheduled?: AnchorEntry;
  released?: AnchorEntry;
};

/**
 * Picks the retainer anchors out of one order's anchors.
 *
 * @param anchors - Anchors already filtered to this order
 * @returns The two retainer anchors, either of which may be absent
 */
export function retainerAnchors(anchors: AnchorEntry[]): RetainerAnchors {
  return {
    scheduled: anchors.find(anchor => anchor.kind === "retainer_scheduled"),
    released: anchors.find(anchor => anchor.kind === "retainer_released"),
  };
}

/**
 * The transaction ids and schedule ids a verifier must fetch for this order.
 *
 * @param anchors - Anchors already filtered to this order
 * @returns The schedule to read and the transfer to read, when each is anchored
 */
export function retainerLookups(anchors: AnchorEntry[]): {
  scheduleId?: string;
  releaseTransactionId?: string;
} {
  const { scheduled, released } = retainerAnchors(anchors);
  return {
    scheduleId: isScheduleId(scheduled?.ref) ? scheduled?.ref : undefined,
    releaseTransactionId: released?.ref ? safeMirrorId(released.ref) : undefined,
  };
}

/**
 * Runs the retainer check.
 *
 * @param input - Verification input, including any retainer evidence that was read
 * @param anchors - This order's anchors, already filtered by mandate id
 * @returns The verdict
 */
export function checkRetainer(input: VerificationInput, anchors: AnchorEntry[]): CheckResult {
  const { scheduled, released } = retainerAnchors(anchors);

  if (!scheduled && !released) {
    return {
      name: CHECK_RETAINER,
      ok: true,
      detail: "not applicable — this order carries no retainer anchors",
    };
  }

  const problems: string[] = [];
  if (!scheduled) {
    problems.push(
      "a retainer_released anchor stands alone: the topic never recorded the authorisation it claims to release",
    );
  }
  if (scheduled && !isScheduleId(scheduled.ref)) {
    problems.push(`the retainer_scheduled anchor names "${scheduled.ref}", which is not a schedule id`);
  }
  if (scheduled && released && compareConsensus(scheduled.consensus_ts, released.consensus_ts) >= 0) {
    problems.push("the release was anchored no later than the authorisation it releases");
  }

  if (!input.retainer) {
    // Not the same as "there is no retainer": the topic says there is one and
    // it was not looked up, which is a gap in the check, not in the evidence.
    return fail(
      CHECK_RETAINER,
      [...problems, "the retainer anchors were not resolved against the mirror node"].join("; "),
    );
  }

  const payment = input.receipt.data.payment;
  const { schedule, release } = input.retainer;

  if (!schedule) {
    problems.push(`schedule ${scheduled?.ref ?? "(unnamed)"} is not on the mirror node`);
  } else {
    if (scheduled?.ref && schedule.schedule_id !== scheduled.ref) {
      problems.push(`the mirror node returned schedule ${schedule.schedule_id}, not ${scheduled.ref}`);
    }
    if (schedule.deleted) {
      problems.push("the schedule was deleted, so nothing was ever held");
    }
    if (schedule.creator_account_id && schedule.creator_account_id !== payment.payer) {
      problems.push(
        `the retainer was authorised by ${schedule.creator_account_id}, but the receipt's payer is ${payment.payer}`,
      );
    }
  }

  if (!released) {
    if (schedule?.executed_timestamp) {
      problems.push(
        `the schedule executed at ${schedule.executed_timestamp} but the topic holds no retainer_released anchor`,
      );
    }
    if (problems.length > 0) {
      return fail(CHECK_RETAINER, problems.join("; "));
    }
    return {
      name: CHECK_RETAINER,
      ok: true,
      detail:
        `${scheduled?.ref} authorised by ${payment.payer} at #${scheduled?.seq}, still pending` +
        `${schedule?.expiration_time ? ` (expires ${schedule.expiration_time})` : ""}` +
        " — the amount is fixed in the scheduled transaction and is confirmed on release",
    };
  }

  const tinybars = releasedAmount(release, payment.payer, payment.payee, problems);

  if (release) {
    if (release.result !== "SUCCESS") {
      problems.push(`the released transfer ended as ${release.result}`);
    }
    if (release.scheduled !== true) {
      problems.push(
        "the transaction named by the retainer_released anchor is not the transfer a schedule executed",
      );
    }
    if (
      schedule?.executed_timestamp &&
      release.consensus_timestamp &&
      schedule.executed_timestamp !== release.consensus_timestamp
    ) {
      problems.push(
        `the schedule executed at ${schedule.executed_timestamp}, but the anchored transfer reached consensus at ${release.consensus_timestamp}`,
      );
    }
    if (schedule && !schedule.executed_timestamp) {
      problems.push("the schedule reports no execution, so this transfer is not the one it holds");
    }
    problems.push(...releasedAfterDelivery(anchors, release));
  } else {
    problems.push(`the released transfer ${released.ref} is not on the mirror node`);
  }

  if (tinybars !== null) {
    const facts: RetainerFacts = {
      network: payment.network,
      payer: payment.payer,
      payee: payment.payee,
      tinybars,
      schedule_id: scheduled?.ref ?? "",
      transaction_id: released.ref,
    };
    if (scheduled) {
      const expected = retainerAnchorHash("scheduled", facts);
      if (expected !== scheduled.hash.toLowerCase()) {
        problems.push(
          `the retainer_scheduled anchor does not cover the retainer the ledger shows (anchored ${short(scheduled.hash)}, ledger implies ${short(expected)})`,
        );
      }
    }
    const expectedReleased = retainerAnchorHash("released", facts);
    if (expectedReleased !== released.hash.toLowerCase()) {
      problems.push(
        `the retainer_released anchor does not cover the transfer the ledger shows (anchored ${short(released.hash)}, ledger implies ${short(expectedReleased)})`,
      );
    }
  }

  if (problems.length > 0) {
    return fail(CHECK_RETAINER, problems.join("; "));
  }

  return {
    name: CHECK_RETAINER,
    ok: true,
    detail:
      `${tinybars} tinybars held on schedule ${scheduled?.ref} by ${payment.payer}, ` +
      `released by ${payment.payee} at ${release?.consensus_timestamp} (#${scheduled?.seq} → #${released.seq})`,
  };
}

/**
 * The amount the transfer actually moved between the two named accounts.
 *
 * Taken from the ledger rather than from the anchor on purpose: the anchored
 * hash is then checked against this number, so an anchor claiming a different
 * amount cannot pass.
 *
 * @param release - The executed transfer
 * @param payer - Account that must have been debited
 * @param payee - Account that must have been credited
 * @param problems - Collector for anything wrong
 * @returns The amount in tinybars, or null when the transfer does not show one
 */
function releasedAmount(
  release: MirrorTransaction | null,
  payer: string,
  payee: string,
  problems: string[],
): number | null {
  if (!release) {
    return null;
  }
  const transfers = release.transfers ?? [];
  const credit = transfers.find(transfer => transfer.account === payee && transfer.amount > 0);
  if (!credit) {
    problems.push(`the released transfer credits nothing to ${payee}`);
    return null;
  }
  const debited = transfers.some(
    transfer => transfer.account === payer && transfer.amount === -credit.amount,
  );
  if (!debited) {
    problems.push(`the released transfer does not debit ${credit.amount} tinybars from ${payer}`);
  }
  return credit.amount;
}

/**
 * Whether the release came after the work was anchored as delivered.
 *
 * This is what separates a retainer from an ordinary scheduled payment: the
 * money was authorised before the work and moved after it, and both instants
 * are fixed by consensus rather than by either party's clock.
 *
 * @param anchors - This order's anchors
 * @param release - The executed transfer
 * @returns Problems found; empty when the ordering holds
 */
function releasedAfterDelivery(anchors: AnchorEntry[], release: MirrorTransaction): string[] {
  const delivered = anchors.find(anchor => anchor.kind === "delivered");
  if (!delivered) {
    return ["there is no delivered anchor to place the release against"];
  }
  if (!release.consensus_timestamp) {
    return ["the released transfer carries no consensus timestamp"];
  }
  if (compareConsensus(release.consensus_timestamp, delivered.consensus_ts) <= 0) {
    return [
      `the retainer was released at ${release.consensus_timestamp}, at or before the delivery anchored at ${delivered.consensus_ts}`,
    ];
  }
  return [];
}

/**
 * Converts an id to mirror form without throwing on rubbish read off a topic.
 *
 * @param transactionId - Candidate id
 * @returns The mirror form, or the input unchanged when it is not an id
 */
function safeMirrorId(transactionId: string): string {
  try {
    return toMirrorTxId(transactionId);
  } catch {
    return transactionId;
  }
}

/**
 * Builds a failing result.
 *
 * @param name - Check name
 * @param detail - What went wrong
 * @returns The verdict
 */
function fail(name: string, detail: string): CheckResult {
  return { name, ok: false, detail };
}

/**
 * Shortens a hash for a one-line message.
 *
 * @param value - Hash, possibly undefined
 * @returns A short form ending in an ellipsis
 */
function short(value: string | undefined): string {
  if (!value) {
    return "(none)";
  }
  return value.length <= 16 ? value : `${value.slice(0, 12)}…`;
}

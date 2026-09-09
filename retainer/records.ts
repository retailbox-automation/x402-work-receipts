/**
 * The retainer, as it is written to the public audit topic.
 *
 * A retainer is a Hedera Scheduled Transaction: the customer authorises one
 * HBAR transfer to the contractor before the work exists, and the transfer
 * stays pending on the ledger until the contractor releases it. Two anchors
 * record that on the same topic as the rest of the order — `retainer_scheduled`
 * when the authorisation is created, `retainer_released` when it executes.
 *
 * As everywhere else in this repository the anchor carries a hash and a public
 * id, never content. The hash is taken over exactly the facts a stranger can
 * re-read from the mirror node — network, both accounts, the amount, the
 * schedule and, once it has run, the transaction — so the verifier can
 * recompute it and see that the topic and the ledger describe the same
 * retainer. A hash nobody can recompute would prove nothing.
 */
import { ANCHOR_VERSION, type AnchorRecord, toMirrorTxId } from "../anchor/records.js";
import { canonicalize, sha256Hex } from "../protocol/canonical.js";

/** Schema tag of the hashed retainer facts. Not a document — only a hash pre-image. */
export const RETAINER_ANCHOR_VERSION = "wr-retainer.v1";

/** The two moments of a retainer: authorised by the customer, released by the contractor. */
export type RetainerStage = "scheduled" | "released";

/**
 * What the ledger says about one retainer.
 *
 * `transaction_id` belongs to the released stage only, in mirror-node form: at
 * the scheduled stage the transfer has not run and has no record to point at.
 */
export type RetainerFacts = {
  /** CAIP-2 network the transfer settles on, e.g. `hedera:testnet`. */
  network: string;
  /** Customer account the retainer debits. */
  payer: string;
  /** Contractor account it credits. */
  payee: string;
  /** Amount held, in tinybars. */
  tinybars: number;
  /** Schedule entity id, `0.0.x`. */
  schedule_id: string;
  /** The executed transfer, mirror form; released stage only. */
  transaction_id?: string;
};

/**
 * Hash anchored for one stage of a retainer.
 *
 * @param stage - Which moment is being anchored
 * @param facts - The retainer as the ledger will show it
 * @returns Lowercase sha-256 hex
 */
export function retainerAnchorHash(stage: RetainerStage, facts: RetainerFacts): string {
  return sha256Hex(canonicalize(hashPreimage(stage, facts)));
}

/**
 * Builds the anchor record for one stage.
 *
 * The `ref` differs by stage on purpose: a schedule is an entity and is read at
 * `/api/v1/schedules/{id}`, the executed transfer is a transaction and is read
 * at `/api/v1/transactions/{id}`. Putting one where the other belongs would
 * send a verifier to the wrong endpoint, so {@link assertWritableAnchor}
 * rejects it before anything reaches a permanent topic.
 *
 * @param stage - Which moment is being anchored
 * @param mandateId - The order this retainer belongs to
 * @param facts - The retainer as the ledger will show it
 * @param at - Claimed time of the anchor; now by default
 * @returns The record to submit
 * @throws TypeError when the released stage carries no transaction id
 */
export function buildRetainerAnchor(
  stage: RetainerStage,
  mandateId: string,
  facts: RetainerFacts,
  at: string = new Date().toISOString(),
): AnchorRecord {
  if (stage === "released" && !facts.transaction_id) {
    throw new TypeError("A released retainer needs the transaction id of the executed transfer");
  }
  return {
    v: ANCHOR_VERSION,
    kind: stage === "scheduled" ? "retainer_scheduled" : "retainer_released",
    mandate_id: mandateId,
    hash: retainerAnchorHash(stage, facts),
    ref: stage === "scheduled" ? facts.schedule_id : toMirrorTxId(facts.transaction_id as string),
    at,
  };
}

/**
 * Normalises the scheduled transaction id the SDK reports.
 *
 * A schedule receipt returns `0.0.x@sec.nanos?scheduled`. The `?scheduled` flag
 * says the id names the *inner* transfer rather than the ScheduleCreate that
 * carries the same id — but the mirror node does not accept the flag in a path,
 * and `toMirrorTxId` does not know it, so it is stripped here rather than in
 * five call sites.
 *
 * @param scheduledTransactionId - Id as the SDK prints it
 * @returns The same transaction in mirror-node form
 */
export function toMirrorScheduledTxId(scheduledTransactionId: string): string {
  return toMirrorTxId(scheduledTransactionId.replace(/\?scheduled$/, ""));
}

/**
 * The exact object a hash is taken over.
 *
 * Written once and used by both the writer and the verifier, so the two cannot
 * drift into hashing different shapes of the same facts.
 *
 * @param stage - Which moment is being anchored
 * @param facts - The retainer as the ledger will show it
 * @returns The pre-image object
 */
function hashPreimage(stage: RetainerStage, facts: RetainerFacts): Record<string, unknown> {
  const preimage: Record<string, unknown> = {
    v: RETAINER_ANCHOR_VERSION,
    stage,
    network: facts.network,
    payer: facts.payer,
    payee: facts.payee,
    tinybars: facts.tinybars,
    schedule_id: facts.schedule_id,
  };
  if (stage === "released") {
    preimage.transaction_id = toMirrorScheduledTxId(facts.transaction_id as string);
  }
  return preimage;
}

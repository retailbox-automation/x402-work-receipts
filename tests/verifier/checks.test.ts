/**
 * The five checks, exercised against one real testnet run and against precise
 * mutations of it.
 *
 * Every check is a pure function over `(receipt, anchors, transactions)`, so a
 * test can change exactly one field and see exactly one verdict move. That is
 * the whole reason the checks take data rather than fetching it themselves.
 */
import { describe, expect, it } from "vitest";
import { toMirrorTxId } from "../../anchor/records";
import type { AnchorEntry } from "../../anchor/records";
import {
  CHECK_ANCHOR_SEQUENCE,
  CHECK_MANDATE_LINK,
  CHECK_NAMES,
  CHECK_PAYMENTS,
  CHECK_RECEIPT_ANCHOR,
  CHECK_SIGNATURE,
  anchorsForMandate,
  checkAnchorSequence,
  checkMandateLinkage,
  checkPayments,
  checkReceiptAnchor,
  checkReceiptSignature,
  paymentTransactionIds,
  runChecks,
} from "../../verifier/checks";
import type { VerificationInput } from "../../verifier/checks";
import {
  GOLDEN_TOPIC,
  anchorsFrom,
  goldenMandate,
  goldenReceipt,
  goldenTransactions,
} from "./helpers";

/**
 * A complete, honest verification input built from the golden run.
 *
 * @returns Input every check should pass
 */
function goldenInput(): VerificationInput {
  return {
    topicId: GOLDEN_TOPIC,
    receipt: goldenReceipt(),
    mandate: goldenMandate(),
    anchors: anchorsFrom(),
    transactions: goldenTransactions(),
  };
}

/**
 * Applies a change to a deep copy of the golden input.
 *
 * @param mutate - Function that edits the copy in place
 * @returns The mutated input
 */
function mutated(mutate: (input: VerificationInput) => void): VerificationInput {
  const input = structuredClone(goldenInput());
  mutate(input);
  return input;
}

/** Anchors of the golden order only, ignoring the other order on the topic. */
function ownAnchors(input: VerificationInput): AnchorEntry[] {
  return anchorsForMandate(input.anchors, input.receipt.data.mandate_id);
}

describe("verifier checks on a real run", () => {
  it("passes all five checks for the golden run", () => {
    const results = runChecks(goldenInput());
    expect(results.map(result => result.name)).toEqual([...CHECK_NAMES]);
    expect(results.filter(result => !result.ok)).toEqual([]);
  });

  it("reads a topic that carries more than one order", () => {
    const all = anchorsFrom();
    const mine = ownAnchors(goldenInput());
    expect(all.length).toBeGreaterThan(mine.length);
    expect(mine).toHaveLength(6);
    expect(new Set(all.map(anchor => anchor.mandate_id)).size).toBeGreaterThan(1);
  });

  it("names both payment transactions in mirror form", () => {
    const receipt = goldenReceipt();
    const ids = paymentTransactionIds(receipt);
    expect(ids).toEqual([
      toMirrorTxId(receipt.data.payment.intake.transaction_id),
      toMirrorTxId(receipt.data.payment.balance!.transaction_id),
    ]);
  });
});

describe("check 1 — receipt signature", () => {
  it("accepts the signature the contractor issued", () => {
    expect(checkReceiptSignature(goldenInput()).ok).toBe(true);
  });

  it("rejects a flipped signature byte", () => {
    const input = mutated(candidate => {
      const value = candidate.receipt.sig.value;
      candidate.receipt.sig.value = `${value.slice(0, -1)}${value.endsWith("a") ? "b" : "a"}`;
    });
    const result = checkReceiptSignature(input);
    expect(result.ok).toBe(false);
    expect(result.name).toBe(CHECK_SIGNATURE);
  });

  it("rejects an edited receipt body", () => {
    const input = mutated(candidate => {
      candidate.receipt.data.result!.pr_url = "https://git.example.com/other/-/merge_requests/1";
    });
    expect(checkReceiptSignature(input).ok).toBe(false);
  });
});

describe("check 2 — mandate hash linkage", () => {
  it("links receipt, anchor and recomputed mandate hash", () => {
    const result = checkMandateLinkage(goldenInput());
    expect(result.ok).toBe(true);
    expect(result.detail).toContain(goldenReceipt().data.mandate_envelope_hash);
  });

  it("still links receipt and anchor when no mandate file is given", () => {
    const input = mutated(candidate => {
      delete candidate.mandate;
    });
    const result = checkMandateLinkage(input);
    expect(result.ok).toBe(true);
    expect(result.detail).toMatch(/mandate file/i);
  });

  it("rejects a receipt whose mandate hash was edited", () => {
    const input = mutated(candidate => {
      const hash = candidate.receipt.data.mandate_envelope_hash;
      candidate.receipt.data.mandate_envelope_hash = `${hash.slice(0, -1)}b`;
    });
    const result = checkMandateLinkage(input);
    expect(result.ok).toBe(false);
    expect(result.name).toBe(CHECK_MANDATE_LINK);
  });

  it("rejects a mandate file for a different order", () => {
    const input = mutated(candidate => {
      candidate.mandate!.data.mandate_id = "some-other-order";
    });
    expect(checkMandateLinkage(input).ok).toBe(false);
  });

  it("rejects a mandate file whose content no longer hashes to the anchor", () => {
    const input = mutated(candidate => {
      candidate.mandate!.data.title = "A different title";
    });
    expect(checkMandateLinkage(input).ok).toBe(false);
  });

  it("fails when the order has no mandate_in anchor at all", () => {
    const input = mutated(candidate => {
      candidate.anchors = candidate.anchors.filter(
        anchor =>
          !(anchor.mandate_id === candidate.receipt.data.mandate_id && anchor.kind === "mandate_in"),
      );
    });
    expect(checkMandateLinkage(input).ok).toBe(false);
  });
});

describe("check 3 — anchor sequence", () => {
  it("finds all six anchors in ascending consensus order", () => {
    const result = checkAnchorSequence(goldenInput());
    expect(result.ok).toBe(true);
    expect(result.detail).toContain("mandate_in");
  });

  it("reports a missing anchor by name", () => {
    const input = mutated(candidate => {
      candidate.anchors = candidate.anchors.filter(
        anchor =>
          !(anchor.mandate_id === candidate.receipt.data.mandate_id && anchor.kind === "delivered"),
      );
    });
    const result = checkAnchorSequence(input);
    expect(result.ok).toBe(false);
    expect(result.name).toBe(CHECK_ANCHOR_SEQUENCE);
    expect(result.detail).toContain("delivered");
  });

  it("rejects anchors that arrived out of order", () => {
    const input = mutated(candidate => {
      const mine = ownAnchors(candidate);
      const delivered = mine.find(anchor => anchor.kind === "delivered")!;
      const balance = mine.find(anchor => anchor.kind === "payment_balance")!;
      const swap = delivered.consensus_ts;
      delivered.consensus_ts = balance.consensus_ts;
      balance.consensus_ts = swap;
      const seq = delivered.seq;
      delivered.seq = balance.seq;
      balance.seq = seq;
    });
    const result = checkAnchorSequence(input);
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/order/i);
  });

  it("rejects a duplicated step", () => {
    const input = mutated(candidate => {
      const mine = ownAnchors(candidate);
      const accepted = mine.find(anchor => anchor.kind === "accepted")!;
      candidate.anchors.push({ ...accepted, seq: 999, consensus_ts: "1888894522.960112104" });
    });
    const result = checkAnchorSequence(input);
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/twice|duplicate/i);
  });

  it("does not accept another order's anchors as this order's", () => {
    const input = mutated(candidate => {
      candidate.anchors = candidate.anchors.map(anchor => ({
        ...anchor,
        mandate_id: "wo-int-1788894580205",
      }));
    });
    expect(checkAnchorSequence(input).ok).toBe(false);
  });
});

describe("check 4 — payments on the ledger", () => {
  it("accepts two settled transfers with the stated parties and amounts", () => {
    const result = checkPayments(goldenInput());
    expect(result.ok).toBe(true);
    expect(result.detail).toContain("intake");
    expect(result.detail).toContain("balance");
  });

  it("fails when a transaction is not on the mirror node", () => {
    const input = mutated(candidate => {
      const id = toMirrorTxId(candidate.receipt.data.payment.intake.transaction_id);
      candidate.transactions.set(id, null);
    });
    const result = checkPayments(input);
    expect(result.ok).toBe(false);
    expect(result.name).toBe(CHECK_PAYMENTS);
    expect(result.detail).toMatch(/not on the mirror node|not found/i);
  });

  it("fails when the transaction did not succeed", () => {
    const input = mutated(candidate => {
      const id = toMirrorTxId(candidate.receipt.data.payment.balance!.transaction_id);
      candidate.transactions.get(id)!.result = "INSUFFICIENT_ACCOUNT_BALANCE";
    });
    expect(checkPayments(input).ok).toBe(false);
  });

  it("fails when the payer was debited a different amount", () => {
    const input = mutated(candidate => {
      const payment = candidate.receipt.data.payment;
      const transaction = candidate.transactions.get(
        toMirrorTxId(payment.intake.transaction_id),
      )!;
      const debit = transaction.transfers.find(
        transfer => transfer.account === payment.payer && transfer.amount < 0,
      )!;
      debit.amount = -1;
    });
    const result = checkPayments(input);
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/payer/i);
  });

  it("fails when the stated payee was never credited", () => {
    const input = mutated(candidate => {
      candidate.receipt.data.payment.payee = "0.0.9999999";
    });
    const result = checkPayments(input);
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/payee/i);
  });

  it("fails when the payer also paid the network fee", () => {
    const input = mutated(candidate => {
      const payment = candidate.receipt.data.payment;
      const oldId = toMirrorTxId(payment.intake.transaction_id);
      const transaction = candidate.transactions.get(oldId)!;
      const selfPaid = `${payment.payer}-1788894509-185405540`;
      transaction.transaction_id = selfPaid;
      payment.intake.transaction_id = `${payment.payer}@1788894509.185405540`;
      candidate.transactions.delete(oldId);
      candidate.transactions.set(selfPaid, transaction);
      const anchor = ownAnchors(candidate).find(entry => entry.kind === "payment_intake")!;
      anchor.ref = selfPaid;
    });
    const result = checkPayments(input);
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/fee/i);
  });

  it("fails when the anchored payment hash does not cover the receipt's payment", () => {
    const input = mutated(candidate => {
      const anchor = ownAnchors(candidate).find(entry => entry.kind === "payment_balance")!;
      anchor.hash = `${anchor.hash.slice(0, -1)}b`;
    });
    const result = checkPayments(input);
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/anchor/i);
  });

  it("fails when the anchor points at a different transaction", () => {
    const input = mutated(candidate => {
      const anchor = ownAnchors(candidate).find(entry => entry.kind === "payment_intake")!;
      anchor.ref = "0.0.7162784-1700000000-000000001";
    });
    expect(checkPayments(input).ok).toBe(false);
  });

  it("fails a receipt that claims delivery without a balance payment", () => {
    const input = mutated(candidate => {
      delete candidate.receipt.data.payment.balance;
    });
    expect(checkPayments(input).ok).toBe(false);
  });
});

describe("check 5 — receipt anchor", () => {
  it("matches the anchored hash to the receipt as signed", () => {
    const result = checkReceiptAnchor(goldenInput());
    expect(result.ok).toBe(true);
    expect(result.name).toBe(CHECK_RECEIPT_ANCHOR);
  });

  it("fails when the receipt was edited after it was anchored", () => {
    const input = mutated(candidate => {
      candidate.receipt.data.result!.notion_status = "Done";
    });
    expect(checkReceiptAnchor(input).ok).toBe(false);
  });

  it("fails when the receipt anchor is missing", () => {
    const input = mutated(candidate => {
      candidate.anchors = candidate.anchors.filter(
        anchor =>
          !(anchor.mandate_id === candidate.receipt.data.mandate_id && anchor.kind === "receipt"),
      );
    });
    expect(checkReceiptAnchor(input).ok).toBe(false);
  });
});

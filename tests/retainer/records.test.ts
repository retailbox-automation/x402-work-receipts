/**
 * The retainer's own records: what may be written to a public topic, and what
 * the anchored hash covers.
 *
 * The anchor rules matter more than they look. A topic is permanent, and an
 * anchor whose `ref` points at the wrong kind of thing sends every later reader
 * to the wrong mirror-node endpoint — where the honest answer is "not found",
 * which reads as "the retainer is not on the ledger".
 */
import { describe, expect, it } from "vitest";
import { ANCHOR_KINDS, assertWritableAnchor, encodeAnchor, isScheduleId, parseAnchor } from "../../anchor/records";
import {
  RETAINER_ANCHOR_VERSION,
  type RetainerFacts,
  buildRetainerAnchor,
  retainerAnchorHash,
  toMirrorScheduledTxId,
} from "../../retainer/records";

/** The retainer of the testnet run recorded in `docs/extras/retainer.md`. */
const FACTS: RetainerFacts = {
  network: "hedera:testnet",
  payer: "0.0.10365982",
  payee: "0.0.10365984",
  tinybars: 1_000_000,
  schedule_id: "0.0.10440150",
  transaction_id: "0.0.10365982-1788962296-502636449",
};

const MANDATE = "01a0826c-11d6-7b61-b75d-3ae618a2776a";

describe("retainer anchor kinds", () => {
  it("adds exactly two kinds and leaves the required six alone", () => {
    expect([...ANCHOR_KINDS]).toEqual([
      "mandate_in",
      "accepted",
      "delivered",
      "payment_intake",
      "payment_balance",
      "receipt",
      "retainer_scheduled",
      "retainer_released",
    ]);
  });

  it("writes a schedule id on the authorisation and a transaction id on the release", () => {
    const scheduled = buildRetainerAnchor("scheduled", MANDATE, FACTS);
    const released = buildRetainerAnchor("released", MANDATE, FACTS);

    expect(scheduled.kind).toBe("retainer_scheduled");
    expect(scheduled.ref).toBe(FACTS.schedule_id);
    expect(released.kind).toBe("retainer_released");
    expect(released.ref).toBe(FACTS.transaction_id);

    expect(() => assertWritableAnchor(scheduled)).not.toThrow();
    expect(() => assertWritableAnchor(released)).not.toThrow();
  });

  it("refuses a transaction id where a schedule id belongs, and the reverse", () => {
    const scheduled = { ...buildRetainerAnchor("scheduled", MANDATE, FACTS), ref: FACTS.transaction_id };
    const released = { ...buildRetainerAnchor("released", MANDATE, FACTS), ref: FACTS.schedule_id };

    expect(() => assertWritableAnchor(scheduled)).toThrow(/schedule id/);
    expect(() => assertWritableAnchor(released)).toThrow(/transaction id/);
  });

  it("refuses either kind with no ref at all", () => {
    for (const stage of ["scheduled", "released"] as const) {
      const anchor = buildRetainerAnchor(stage, MANDATE, FACTS);
      delete anchor.ref;
      expect(() => assertWritableAnchor(anchor)).toThrow(/needs a/);
    }
  });

  it("refuses to build a release with no transaction to point at", () => {
    const { transaction_id, ...pending } = FACTS;
    expect(() => buildRetainerAnchor("released", MANDATE, pending)).toThrow(/transaction id/);
  });

  it("survives a round trip through the topic body", () => {
    const anchor = buildRetainerAnchor("released", MANDATE, FACTS);
    expect(parseAnchor(encodeAnchor(anchor))).toEqual(anchor);
  });

  it("recognises entity ids and rejects transaction ids", () => {
    expect(isScheduleId("0.0.10440150")).toBe(true);
    expect(isScheduleId("0.0.10365982-1788962296-502636449")).toBe(false);
    expect(isScheduleId("0.0.10365982@1788962296.502636449")).toBe(false);
    expect(isScheduleId(undefined)).toBe(false);
  });
});

describe("retainer anchor hash", () => {
  it("is stable for the same facts and differs between the two stages", () => {
    expect(retainerAnchorHash("scheduled", FACTS)).toBe(retainerAnchorHash("scheduled", { ...FACTS }));
    expect(retainerAnchorHash("scheduled", FACTS)).not.toBe(retainerAnchorHash("released", FACTS));
    expect(retainerAnchorHash("scheduled", FACTS)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("ignores the transaction id before the transfer has run", () => {
    const { transaction_id, ...pending } = FACTS;
    expect(retainerAnchorHash("scheduled", pending)).toBe(retainerAnchorHash("scheduled", FACTS));
  });

  it("moves when any fact the ledger shows is changed", () => {
    const baseline = retainerAnchorHash("released", FACTS);
    const mutations: Partial<RetainerFacts>[] = [
      { tinybars: 1_000_001 },
      { payer: "0.0.10365983" },
      { payee: "0.0.10365985" },
      { network: "hedera:mainnet" },
      { schedule_id: "0.0.10440151" },
      { transaction_id: "0.0.10365982-1788962296-502636450" },
    ];
    for (const mutation of mutations) {
      expect(retainerAnchorHash("released", { ...FACTS, ...mutation })).not.toBe(baseline);
    }
  });

  it("names its own schema in the pre-image, so a hash cannot be reused elsewhere", () => {
    expect(RETAINER_ANCHOR_VERSION).toBe("wr-retainer.v1");
  });
});

describe("toMirrorScheduledTxId", () => {
  it("strips the ?scheduled flag the SDK prints and converts to mirror form", () => {
    expect(toMirrorScheduledTxId("0.0.10365982@1788962296.502636449?scheduled")).toBe(
      "0.0.10365982-1788962296-502636449",
    );
  });

  it("leaves an id that is already in mirror form alone", () => {
    expect(toMirrorScheduledTxId("0.0.10365982-1788962296-502636449")).toBe(
      "0.0.10365982-1788962296-502636449",
    );
  });

  it("refuses anything that is not a transaction id", () => {
    expect(() => toMirrorScheduledTxId("0.0.10440150")).toThrow(/transaction id/);
  });
});

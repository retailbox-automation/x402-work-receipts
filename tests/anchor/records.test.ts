import { describe, expect, it } from "vitest";
import {
  ANCHOR_VERSION,
  type AnchorRecord,
  canonicalize,
  encodeAnchor,
  fromMirrorTxId,
  isAnchorRecord,
  parseAnchor,
  toMirrorTxId,
} from "../../anchor/records";

/** A hash that looks like what `protocol/envelope.ts` produces. */
const HASH = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

/** Transaction ids from the day-1 spike, in the form the facilitator returns. */
const SPIKE_TX_IDS = [
  "0.0.7162784@1788539597.122303478",
  "0.0.7162784@1788539653.433840739",
  "0.0.7162784@1788540153.262607741",
];

/**
 * Builds a valid anchor record.
 *
 * @param overrides - Fields to replace
 * @returns An anchor record
 */
function record(overrides: Partial<AnchorRecord> = {}): AnchorRecord {
  return {
    v: ANCHOR_VERSION,
    kind: "mandate_in",
    mandate_id: "wo-2026-0001",
    hash: HASH,
    at: "2026-09-04T16:34:19.050Z",
    ...overrides,
  };
}

describe("canonicalize", () => {
  it("sorts object keys by UTF-16 code unit and emits no whitespace", () => {
    // The key set from the RFC 8785 sorting example. The expected order is
    // neither alphabetical nor insertion order: it is by code unit.
    const value = {
      "€": "Euro Sign",
      "\r": "Carriage Return",
      "\n": "Newline",
      "1": "One",
      "\u0080": "Control\u007f",
      "ö": "Latin Small Letter O With Diaeresis",
      "דּ": "Hebrew Letter Dalet With Dagesh",
      "</script>": "Browser Challenge",
    };

    expect(canonicalize(value)).toBe(
      '{"\\n":"Newline","\\r":"Carriage Return","1":"One","</script>":"Browser Challenge",' +
        '"\u0080":"Control\u007f","ö":"Latin Small Letter O With Diaeresis",' +
        '"€":"Euro Sign","דּ":"Hebrew Letter Dalet With Dagesh"}',
    );
  });

  it("sorts nested objects too and keeps array order", () => {
    expect(canonicalize({ b: { d: 1, c: [3, 1, 2] }, a: null })).toBe(
      '{"a":null,"b":{"c":[3,1,2],"d":1}}',
    );
  });

  it("serialises numbers with JavaScript number semantics", () => {
    expect(canonicalize(1)).toBe("1");
    expect(canonicalize(1.0)).toBe("1");
    expect(canonicalize(-0)).toBe("0");
    expect(canonicalize(0.000001)).toBe("0.000001");
    expect(canonicalize(1e-7)).toBe("1e-7");
    expect(canonicalize(1e21)).toBe("1e+21");
    expect(canonicalize(Number.MAX_SAFE_INTEGER)).toBe("9007199254740991");
    expect(canonicalize(5e-324)).toBe("5e-324");
  });

  it("escapes strings the way JSON.stringify does", () => {
    expect(canonicalize("a\u0001b")).toBe('"a\\u0001b"');
    expect(canonicalize('quote " and backslash \\')).toBe('"quote \\" and backslash \\\\"');
    expect(canonicalize("tab\there")).toBe('"tab\\there"');
    // Printable non-ASCII stays literal — it is not escaped.
    expect(canonicalize("€ ö")).toBe('"€ ö"');
  });

  it("drops undefined members and renders undefined array items as null", () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(canonicalize([1, undefined, 2])).toBe("[1,null,2]");
  });

  it("refuses values JSON cannot represent", () => {
    expect(() => canonicalize(Number.NaN)).toThrow(/non-finite/i);
    expect(() => canonicalize(Number.POSITIVE_INFINITY)).toThrow(/non-finite/i);
  });
});

describe("encodeAnchor", () => {
  it("produces stable canonical bytes for a record", () => {
    expect(encodeAnchor(record())).toBe(
      `{"at":"2026-09-04T16:34:19.050Z","hash":"${HASH}","kind":"mandate_in",` +
        '"mandate_id":"wo-2026-0001","v":"wr-anchor.v1"}',
    );
  });

  it("does not depend on the order the record was built in", () => {
    const built: AnchorRecord = {
      at: "2026-09-04T16:34:19.050Z",
      hash: HASH,
      mandate_id: "wo-2026-0001",
      kind: "mandate_in",
      v: ANCHOR_VERSION,
    };
    expect(encodeAnchor(built)).toBe(encodeAnchor(record()));
  });

  it("keeps the transaction id of a payment step", () => {
    const mirrorId = toMirrorTxId(SPIKE_TX_IDS[1]);
    expect(encodeAnchor(record({ kind: "payment_intake", ref: mirrorId }))).toBe(
      `{"at":"2026-09-04T16:34:19.050Z","hash":"${HASH}","kind":"payment_intake",` +
        `"mandate_id":"wo-2026-0001","ref":"${mirrorId}","v":"wr-anchor.v1"}`,
    );
  });

  it("omits ref rather than writing null when it is absent", () => {
    expect(encodeAnchor({ ...record(), ref: undefined })).not.toContain("ref");
  });

  it("refuses records that would pollute the public log", () => {
    expect(() => encodeAnchor(record({ hash: HASH.toUpperCase() }))).toThrow(/lowercase/);
    expect(() => encodeAnchor(record({ hash: "not-a-hash" }))).toThrow(/wr-anchor\.v1/);
    expect(() => encodeAnchor(record({ mandate_id: "" }))).toThrow(/wr-anchor\.v1/);
    expect(() => encodeAnchor(record({ at: "some time yesterday" }))).toThrow(/wr-anchor\.v1/);
    expect(() => encodeAnchor(record({ kind: "shipped" as never }))).toThrow(/wr-anchor\.v1/);
    expect(() => encodeAnchor(record({ kind: "payment_balance" }))).toThrow(/needs a transaction id/);
    // The facilitator form of the id is the one thing a payment anchor must not carry.
    expect(() => encodeAnchor(record({ kind: "payment_balance", ref: SPIKE_TX_IDS[0] }))).toThrow(
      /mirror-node transaction id/,
    );
  });
});

describe("parseAnchor and isAnchorRecord", () => {
  it("round-trips a record through its canonical bytes", () => {
    const original = record({ kind: "payment_intake", ref: toMirrorTxId(SPIKE_TX_IDS[2]) });
    expect(parseAnchor(encodeAnchor(original))).toEqual(original);
  });

  it("returns null for anything that is not an anchor", () => {
    expect(parseAnchor("not json at all")).toBeNull();
    expect(parseAnchor(JSON.stringify({ messageType: "NeuronHeartBeat" }))).toBeNull();
    expect(parseAnchor(JSON.stringify({ ...record(), v: "wr-anchor.v2" }))).toBeNull();
    expect(parseAnchor(JSON.stringify({ ...record(), hash: "short" }))).toBeNull();
    expect(parseAnchor(JSON.stringify([record()]))).toBeNull();
  });

  it("reads a record written with an uppercase hash, which we never write ourselves", () => {
    expect(isAnchorRecord({ ...record(), hash: HASH.toUpperCase() })).toBe(true);
  });
});

describe("transaction id conversion", () => {
  it("converts the spike transaction id to mirror-node form and back", () => {
    expect(toMirrorTxId("0.0.7162784@1788539653.433840739")).toBe(
      "0.0.7162784-1788539653-433840739",
    );
    expect(fromMirrorTxId("0.0.7162784-1788539653-433840739")).toBe(
      "0.0.7162784@1788539653.433840739",
    );
  });

  it("round-trips every transaction id the spike settled", () => {
    for (const id of SPIKE_TX_IDS) {
      expect(fromMirrorTxId(toMirrorTxId(id))).toBe(id);
    }
  });

  it("leaves an id that is already in the target form alone", () => {
    expect(toMirrorTxId("0.0.7162784-1788539653-433840739")).toBe(
      "0.0.7162784-1788539653-433840739",
    );
    expect(fromMirrorTxId("0.0.7162784@1788539653.433840739")).toBe(
      "0.0.7162784@1788539653.433840739",
    );
  });

  it("keeps the nanosecond part intact, including leading zeros", () => {
    expect(toMirrorTxId("0.0.5@1788539653.000000042")).toBe("0.0.5-1788539653-000000042");
    expect(fromMirrorTxId("0.0.5-1788539653-000000042")).toBe("0.0.5@1788539653.000000042");
  });

  it("rejects anything that is not a transaction id instead of passing it through", () => {
    expect(() => toMirrorTxId("0.0.7162784@1788539653")).toThrow(/transaction id/);
    expect(() => toMirrorTxId("")).toThrow(/transaction id/);
    expect(() => fromMirrorTxId("0.0.7162784")).toThrow(/transaction id/);
    expect(() => fromMirrorTxId("0.0.7162784-1788539653")).toThrow(/transaction id/);
  });
});

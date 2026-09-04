/**
 * Canonical JSON (RFC 8785) and SHA-256 hex.
 *
 * The vectors below are taken from RFC 8785 (key ordering by UTF-16 code
 * units, ES6 number serialization) and from the SHA-256 test vectors.
 */
import { describe, expect, it } from "vitest";
import { canonicalize, sha256Hex } from "../../protocol/canonical.js";

describe("canonicalize", () => {
  it("sorts object keys and keeps array order", () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalize([3, 1, { b: 2, a: 1 }])).toBe('[3,1,{"a":1,"b":2}]');
  });

  it("produces the same bytes regardless of key insertion order", () => {
    const first = canonicalize({ z: { y: 1, x: [1, 2] }, a: "one" });
    const second = canonicalize({ a: "one", z: { x: [1, 2], y: 1 } });
    expect(first).toBe(second);
    expect(first).toBe('{"a":"one","z":{"x":[1,2],"y":1}}');
  });

  it("orders keys by UTF-16 code units (RFC 8785 appendix B)", () => {
    const input: Record<string, string> = {
      "€": "Euro Sign",
      "\r": "Carriage Return",
      "דּ": "Hebrew Letter Dalet With Dagesh",
      "1": "One",
      "😀": "Emoji: Grinning Face",
      "\u0080": "Control",
      "ö": "Latin Small Letter O With Diaeresis",
    };
    const expected =
      '{"\\r":"Carriage Return",' +
      '"1":"One",' +
      '"\u0080":"Control",' +
      '"ö":"Latin Small Letter O With Diaeresis",' +
      '"€":"Euro Sign",' +
      '"😀":"Emoji: Grinning Face",' +
      '"דּ":"Hebrew Letter Dalet With Dagesh"}';
    expect(canonicalize(input)).toBe(expected);
  });

  it("serializes numbers with ES6 semantics", () => {
    expect(canonicalize([0, -0, 1e30, 1e-7, 1e21, 1e20, 0.000001, 5e-324])).toBe(
      "[0,0,1e+30,1e-7,1e+21,100000000000000000000,0.000001,5e-324]",
    );
    expect(canonicalize(333333333.33333329)).toBe("333333333.3333333");
    expect(canonicalize(9007199254740991)).toBe("9007199254740991");
  });

  it("escapes only what JSON requires", () => {
    expect(canonicalize({ "a b": 'line\nfeed " \\ \u0001' })).toBe('{"a b":"line\\nfeed \\" \\\\ \\u0001"}');
  });

  it("drops undefined members and keeps null", () => {
    expect(canonicalize({ a: undefined, b: null, c: 1 })).toBe('{"b":null,"c":1}');
  });

  it("serializes top-level literals", () => {
    expect(canonicalize(true)).toBe("true");
    expect(canonicalize("x")).toBe('"x"');
    expect(canonicalize(5)).toBe("5");
    expect(canonicalize(null)).toBe("null");
  });

  it("rejects non-finite numbers (RFC 8785 section 3.2.2.3)", () => {
    expect(() => canonicalize({ x: NaN })).toThrow();
    expect(() => canonicalize({ x: Infinity })).toThrow();
  });
});

describe("sha256Hex", () => {
  it("matches the published SHA-256 vectors", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("hashes a string as its UTF-8 bytes", () => {
    const bytes = new TextEncoder().encode("héllo €");
    expect(sha256Hex("héllo €")).toBe(sha256Hex(bytes));
  });

  it("returns lowercase hex of 64 characters", () => {
    expect(sha256Hex(canonicalize({ a: 1 }))).toMatch(/^[0-9a-f]{64}$/);
  });
});

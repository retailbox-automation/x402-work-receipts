/**
 * HCS-14 identifiers: the format, and the one property the whole extra rests on
 * — that a `uaid:did:z6Mk…` can be turned back into the public key that signed.
 *
 * The `did:key` identifier used as a fixture below is the Ed25519 example
 * published in the W3C did:key specification, so the encoding is checked
 * against a string this repository did not produce. The Base58 step is checked
 * a second time against a deliberately naive implementation written here: two
 * independent implementations agreeing is evidence, one implementation
 * agreeing with itself is not.
 */
import { describe, expect, it } from "vitest";
import { publicKeyHex } from "../../protocol/envelope";
import {
  DID_KEY_ED25519_PREFIX,
  UAID_PARAM_ORDER,
  canonicalAgentJson,
  deriveAid,
  didKeyFromPublicKey,
  hederaNativeId,
  isUaid,
  parseUaid,
  publicKeyForUaid,
  publicKeyFromDidKey,
  uaidFromPublicKey,
  uaidMatchesPublicKey,
  uaidProblems,
} from "../../protocol/identity";

/** The Ed25519 example identifier from the W3C did:key specification. */
const PUBLISHED_DID_KEY = "z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";

/** A signing key that exists only in this file. */
const SECRET_KEY = "11".repeat(32);

/** Its public key. */
const PUBLIC_KEY = publicKeyHex(SECRET_KEY);

/** Base58 alphabet, as Bitcoin defined it and `did:key` inherited it. */
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/**
 * Base58, written the slow obvious way, as a check on the library.
 *
 * @param bytes - Input bytes
 * @returns The base58 encoding, leading zero bytes kept as "1"
 */
function naiveBase58(bytes: Uint8Array): string {
  let number = 0n;
  for (const byte of bytes) {
    number = number * 256n + BigInt(byte);
  }
  let out = "";
  while (number > 0n) {
    out = BASE58_ALPHABET[Number(number % 58n)] + out;
    number /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = "1" + out;
  }
  return out;
}

describe("did:key encoding", () => {
  it("decodes the identifier published in the did:key specification", () => {
    const key = publicKeyFromDidKey(PUBLISHED_DID_KEY);
    expect(key).not.toBeNull();
    expect(key).toHaveLength(64);
    expect(didKeyFromPublicKey(key!)).toBe(PUBLISHED_DID_KEY);
  });

  it("accepts the same identifier with its did:key prefix", () => {
    expect(publicKeyFromDidKey(`did:key:${PUBLISHED_DID_KEY}`)).toBe(
      publicKeyFromDidKey(PUBLISHED_DID_KEY),
    );
  });

  it("agrees with an independent base58 implementation", () => {
    const bytes = Uint8Array.from([
      ...DID_KEY_ED25519_PREFIX,
      ...Buffer.from(PUBLIC_KEY, "hex"),
    ]);
    expect(didKeyFromPublicKey(PUBLIC_KEY)).toBe(`z${naiveBase58(bytes)}`);
  });

  it("carries the Ed25519 multicodec prefix, so every identifier starts z6Mk", () => {
    expect(didKeyFromPublicKey(PUBLIC_KEY).startsWith("z6Mk")).toBe(true);
    expect(DID_KEY_ED25519_PREFIX).toEqual(Uint8Array.of(0xed, 0x01));
  });

  it("returns null rather than throwing on anything that is not one", () => {
    for (const candidate of ["", "agency-x-agent", "z", "znot base58!", "did:web:example.com"]) {
      expect(publicKeyFromDidKey(candidate)).toBeNull();
    }
  });

  it("refuses a key that is not 32 bytes of hex", () => {
    expect(() => didKeyFromPublicKey("abcd")).toThrow(/32 bytes/);
  });
});

describe("uaid from a signing key", () => {
  it("is a did-target identifier that decodes back to the key", () => {
    const uaid = uaidFromPublicKey(PUBLIC_KEY);
    const parsed = parseUaid(uaid);
    expect(parsed?.target).toBe("did");
    expect(parsed?.id).toBe(didKeyFromPublicKey(PUBLIC_KEY));
    expect(publicKeyForUaid(uaid)).toBe(PUBLIC_KEY);
    expect(uaidMatchesPublicKey(uaid, PUBLIC_KEY)).toBe(true);
  });

  it("does not match a different key", () => {
    const other = publicKeyHex("22".repeat(32));
    expect(uaidMatchesPublicKey(uaidFromPublicKey(PUBLIC_KEY), other)).toBe(false);
  });

  it("defaults uid to 0, as the standard requires", () => {
    expect(parseUaid(uaidFromPublicKey(PUBLIC_KEY))?.params["uid"]).toBe("0");
    expect(uaidProblems(uaidFromPublicKey(PUBLIC_KEY))).toEqual([]);
  });

  it("emits parameters in the order the standard fixes", () => {
    const uaid = uaidFromPublicKey(PUBLIC_KEY, {
      domain: "example.com",
      nativeId: "hedera:testnet:0.0.5",
      proto: "rest",
      registry: "self",
      uid: "0",
    });
    const keys = uaid
      .split(";")
      .slice(1)
      .map(pair => pair.split("=")[0]);
    expect(keys).toEqual(["uid", "registry", "proto", "nativeId", "domain"]);
    expect(UAID_PARAM_ORDER.slice(0, 5)).toEqual(keys);
  });

  it("leaves out parameters that were not given", () => {
    expect(uaidFromPublicKey(PUBLIC_KEY, { registry: "self" })).toBe(
      `uaid:did:${didKeyFromPublicKey(PUBLIC_KEY)};uid=0;registry=self`,
    );
  });

  it("refuses a parameter value that would break parsing", () => {
    expect(() => uaidFromPublicKey(PUBLIC_KEY, { registry: "a;b" })).toThrow(/may not contain/);
    expect(() => uaidFromPublicKey(PUBLIC_KEY, { proto: "a=b" })).toThrow(/may not contain/);
  });
});

describe("parsing identifiers", () => {
  it("reads target, id and parameters", () => {
    const parsed = parseUaid("uaid:aid:5J8;uid=7;registry=hol;nativeId=hedera:testnet:0.0.1");
    expect(parsed).toMatchObject({
      target: "aid",
      id: "5J8",
      params: { uid: "7", registry: "hol", nativeId: "hedera:testnet:0.0.1" },
    });
  });

  it("keeps a did method-specific identifier that contains colons", () => {
    expect(parseUaid("uaid:did:web:example.com;uid=0")?.id).toBe("web:example.com");
  });

  it("rejects what is not an identifier", () => {
    for (const candidate of [
      "",
      "agency-x-agent",
      "client-y-agent",
      "uaid:did:",
      "uaid:xyz:abc",
      "did:key:z6Mkhax",
      "uaid:did:z6Mk?x=1",
      "uaid:did:z6Mk#frag",
      "uaid:did:z6Mk;uid",
      "uaid:did:z6Mk;uid=",
      "uaid:did:z6Mk;uid=0;uid=1",
      "uaid:did:z6Mk;=0",
    ]) {
      expect(parseUaid(candidate), candidate).toBeNull();
      expect(isUaid(candidate), candidate).toBe(false);
    }
    expect(parseUaid(undefined)).toBeNull();
    expect(parseUaid(42)).toBeNull();
  });

  it("reports a missing uid as a problem without refusing to read the identifier", () => {
    const uaid = `uaid:did:${didKeyFromPublicKey(PUBLIC_KEY)};registry=self`;
    expect(isUaid(uaid)).toBe(true);
    expect(uaidProblems(uaid)).toEqual([
      'the uid parameter is required and shall be "0" if not applicable',
    ]);
  });

  it("reports a did:key identifier that does not decode to a key", () => {
    const uaid = "uaid:did:z6MkTooShort;uid=0";
    expect(uaidProblems(uaid)).toEqual([
      "the did:key identifier does not decode to an Ed25519 public key",
    ]);
  });

  it("says a plain handle is not an identifier at all", () => {
    expect(uaidProblems("agency-x-agent")).toEqual([
      'not a well-formed uaid: "agency-x-agent"',
    ]);
  });

  it("cannot read a key out of an aid, and says so by returning null", () => {
    expect(publicKeyForUaid("uaid:aid:5J8;uid=0")).toBeNull();
    expect(publicKeyForUaid("uaid:did:web:example.com;uid=0")).toBeNull();
    expect(publicKeyForUaid(null)).toBeNull();
    expect(uaidMatchesPublicKey("uaid:aid:5J8;uid=0", PUBLIC_KEY)).toBe(false);
  });
});

describe("aid derivation", () => {
  /** The standard's first test vector. */
  const AGENT = {
    registry: "hol",
    name: "Support Agent",
    version: "1.0.0",
    protocol: "hcs-10",
    nativeId: "hedera:testnet:0.0.123456",
    skills: [0, 17],
  };

  it("serializes only the six canonical fields, keys in alphabetical order", () => {
    expect(canonicalAgentJson(AGENT)).toBe(
      '{"name":"Support Agent","nativeId":"hedera:testnet:0.0.123456","protocol":"hcs-10","registry":"hol","skills":[0,17],"version":"1.0.0"}',
    );
  });

  it("is deterministic and starts with the aid target", () => {
    const aid = deriveAid(AGENT);
    expect(aid).toBe(deriveAid(AGENT));
    expect(parseUaid(aid)?.target).toBe("aid");
  });

  it("normalizes registry and protocol case, trims strings and sorts skills", () => {
    expect(
      canonicalAgentJson({
        ...AGENT,
        registry: " HOL ",
        protocol: "HCS-10",
        name: " Support Agent ",
        skills: [17, 0],
      }),
    ).toBe(canonicalAgentJson(AGENT));
  });

  it("changes when any canonical field changes", () => {
    expect(deriveAid({ ...AGENT, version: "1.0.1" })).not.toBe(deriveAid(AGENT));
    expect(deriveAid({ ...AGENT, skills: [0, 17, 19] })).not.toBe(deriveAid(AGENT));
  });

  it("does not depend on the routing parameters", () => {
    const withParams = deriveAid(AGENT, { uid: "9", registry: "hol" });
    expect(withParams.split(";")[0]).toBe(deriveAid(AGENT).split(";")[0]);
  });

  it("refuses a missing required field", () => {
    expect(() => canonicalAgentJson({ ...AGENT, nativeId: "  " })).toThrow(/nativeId/);
    expect(() => canonicalAgentJson({ ...AGENT, name: "" })).toThrow(/name/);
  });

  it("refuses skills in the reserved range and skills that are not whole numbers", () => {
    expect(() => deriveAid({ ...AGENT, skills: [0, 40] })).toThrow(/reserved range 40-99/);
    expect(() => deriveAid({ ...AGENT, skills: [0, 99] })).toThrow(/reserved range 40-99/);
    expect(() => deriveAid({ ...AGENT, skills: [1.5] })).toThrow(/whole numbers/);
    expect(deriveAid({ ...AGENT, skills: [0, 100, 10102] })).toContain("uaid:aid:");
  });

  it("accepts an agent with no skills at all", () => {
    expect(canonicalAgentJson({ ...AGENT, skills: undefined })).toContain('"skills":[]');
  });
});

describe("native ids", () => {
  it("builds the CAIP-10 form for a Hedera account", () => {
    expect(hederaNativeId("hedera:testnet", "0.0.5")).toBe("hedera:testnet:0.0.5");
    expect(hederaNativeId("testnet", "0.0.5")).toBe("hedera:testnet:0.0.5");
    expect(hederaNativeId("MAINNET", "0.0.5")).toBe("hedera:mainnet:0.0.5");
  });

  it("is undefined when there is no account to name", () => {
    expect(hederaNativeId("testnet", undefined)).toBeUndefined();
    expect(hederaNativeId("testnet", "  ")).toBeUndefined();
  });
});

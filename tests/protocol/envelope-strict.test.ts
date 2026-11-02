/**
 * Ed25519 small-order keys and R (Agent Action Capsule ts 0.10.0, vector
 * neg-witness-cll-small-order-key).
 *
 * With a public key A of small order, the verify equation [S]B = R + [k]A
 * holds for R = identity, S = 0 over ANY message (and, for A = identity, for
 * R = B, S = 1 too). @noble/ed25519 in its default ZIP-215 mode accepts such
 * a "signature" (as does OpenSSL 4.0.2 under Python's `cryptography` 50.0.1;
 * node 26 with OpenSSL 4.1.0 refuses it), which makes the key one anyone can
 * sign with. `verifyEnvelope` must refuse small-order and
 * non-canonical keys and R before the library runs. A signature with
 * R = identity made by a key's real owner (S = k·a) also satisfies the
 * equation; libsodium refuses it, and so must we.
 */
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, randomBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import { canonicalize } from "../../protocol/canonical.js";
import {
  ED25519_SMALL_ORDER_Y,
  ed25519PointProblem,
  publicKeyHex,
  signEnvelope,
  verifyEnvelope,
} from "../../protocol/envelope.js";
import type { Envelope } from "../../protocol/types.js";

const P = 2n ** 255n - 19n;
const L = 2n ** 252n + 27742317777372353535851937790883648493n;
const ORDER8_Y = [
  2707385501144840649318225287225658788936804267575313519463743609750303402022n,
  55188659117513257062467267217118295137698188065244968500265048394206261417927n,
];

/** Little-endian 32-byte encoding of y with the x sign bit. */
function enc(y: bigint, sign: number): Uint8Array {
  const v = y | (BigInt(sign) << 255n);
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = Number((v >> BigInt(8 * i)) & 0xffn);
  return out;
}

const IDENTITY = enc(1n, 0);
const BASEPOINT = ed.Point.BASE.toBytes();
const CAPSULE_SIG = concat(IDENTITY, new Uint8Array(32)); // R = identity, S = 0
const NORMAL_R_SIG = concat(BASEPOINT, enc(1n, 0)); // R = B, S = 1

/** Every encoding of every small-order point, both x-sign bits. */
const SMALL_ORDER_ENCODINGS = [0n, 1n, P - 1n, ...ORDER8_Y, P, P + 1n].flatMap(y => [enc(y, 0), enc(y, 1)]);
/** Non-canonical encodings of y = 2..18 (y >= p). */
const NON_CANONICAL = Array.from({ length: 17 }, (_, i) => enc(P + 2n + BigInt(i), 0));

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

function bodyWith(n: number | string): Omit<Envelope<unknown>, "sig"> {
  return {
    schema: "mandate.v1",
    from: "anyone",
    to: "agency-x",
    thread_id: "0192c3f0-5b7e-7a10-9d2e-6f1a2b3c4d5e",
    issued_at: "2026-11-02T00:00:00Z",
    data: { content: String(n) },
  };
}

function forged(pub: Uint8Array, sig: Uint8Array, n: number | string = "a"): Envelope<unknown> {
  return { ...bodyWith(n), sig: { alg: "ed25519", pub: bytesToHex(pub), value: bytesToHex(sig) } };
}

function message(env: Omit<Envelope<unknown>, "sig">): Uint8Array {
  return utf8ToBytes(canonicalize(env));
}

function leInt(bytes: Uint8Array): bigint {
  let v = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i]);
  return v;
}

/**
 * A signature only the key's owner can make: R = identity, S = k·a. It
 * satisfies the verify equation; libsodium and the Capsule strict rule refuse
 * it, and @noble/ed25519 accepts it even with `zip215: false` — so only the R
 * check catches it.
 */
function identityRSig(secretHex: string, msg: Uint8Array): Uint8Array {
  const h = sha512(hexToBytes(secretHex)).slice(0, 32);
  h[0] &= 248;
  h[31] &= 127;
  h[31] |= 64;
  const a = leInt(h);
  const pk = hexToBytes(publicKeyHex(secretHex));
  const k = leInt(sha512(concat(concat(IDENTITY, pk), msg))) % L;
  return concat(IDENTITY, enc((k * a) % L, 0));
}

function ownerIdentityREnvelope(secretHex: string): Envelope<unknown> {
  const body = bodyWith("owner");
  const pub = hexToBytes(publicKeyHex(secretHex));
  const sig = identityRSig(secretHex, message(body));
  return { ...body, sig: { alg: "ed25519", pub: bytesToHex(pub), value: bytesToHex(sig) } };
}

const hexId = (b: Uint8Array) => bytesToHex(b).slice(0, 8) + bytesToHex(b).slice(-2);

describe("the gap exists without the strict check (must-differ controls)", () => {
  it("noble's default mode accepts the Capsule forgery over any message", () => {
    for (const n of ["a", "b"]) expect(ed.verify(CAPSULE_SIG, message(bodyWith(n)), IDENTITY)).toBe(true);
  });

  it("noble's default mode accepts R = B, S = 1 under the identity key; R = B is an ordinary point", () => {
    for (const n of ["a", "b"]) expect(ed.verify(NORMAL_R_SIG, message(bodyWith(n)), IDENTITY)).toBe(true);
    expect(ed25519PointProblem(BASEPOINT)).toBeNull();
  });

  it("noble's strict mode still accepts the owner's R = identity signature", () => {
    const env = ownerIdentityREnvelope("9d".repeat(32));
    const { sig, ...body } = env;
    expect(ed.verify(hexToBytes(sig.value), message(body), hexToBytes(sig.pub), { zip215: false })).toBe(true);
  });
});

describe("verifyEnvelope refuses small-order keys and R", () => {
  it("refuses the Capsule vector neg-witness-cll-small-order-key", () => {
    for (const n of ["a", "b"]) expect(verifyEnvelope(forged(IDENTITY, CAPSULE_SIG, n))).toBe(false);
  });

  it("refuses the identity-key forgery whose R is an ordinary point", () => {
    for (const n of ["a", "b"]) expect(verifyEnvelope(forged(IDENTITY, NORMAL_R_SIG, n))).toBe(false);
  });

  it.each(SMALL_ORDER_ENCODINGS.map(raw => [hexId(raw), raw] as const))("refuses small-order key %s", (_id, raw) => {
    expect(ed25519PointProblem(raw)).toBe("small-order");
    // The library's default mode accepts R = identity, S = 0 under this key; the strict check must not.
    for (let n = 0; n < 256; n++) {
      const env = forged(raw, CAPSULE_SIG, n);
      const { sig, ...body } = env;
      if (!ed.verify(hexToBytes(sig.value), message(body), raw)) continue;
      expect(verifyEnvelope(env)).toBe(false);
      return;
    }
    throw new Error("no content found that the library accepts under this key");
  });

  it.each(SMALL_ORDER_ENCODINGS.map(raw => [hexId(raw), raw] as const))(
    "refuses small-order R %s even under a real key",
    (_id, raw) => {
      const env = signEnvelope(bodyWith("real"), bytesToHex(randomBytes(32)));
      const value = hexToBytes(env.sig.value);
      value.set(raw, 0);
      expect(verifyEnvelope({ ...env, sig: { ...env.sig, value: bytesToHex(value) } })).toBe(false);
    },
  );

  it("refuses the owner's own R = identity signature", () => {
    for (const secret of ["9d".repeat(32), bytesToHex(randomBytes(32))]) {
      const env = ownerIdentityREnvelope(secret);
      const { sig, ...body } = env;
      expect(ed.verify(hexToBytes(sig.value), message(body), hexToBytes(sig.pub), { zip215: false })).toBe(true);
      expect(verifyEnvelope(env)).toBe(false);
    }
  });

  it.each(NON_CANONICAL.map(raw => [hexId(raw), raw] as const))("calls key %s non-canonical", (_id, raw) => {
    expect(ed25519PointProblem(raw)).toBe("non-canonical");
  });

  it.each([new Uint8Array(0), new Uint8Array(31), new Uint8Array(33)])("calls %s bytes a wrong length", raw => {
    expect(ed25519PointProblem(raw)).toBe("length");
  });
});

describe("the blocklist", () => {
  it("covers all eight small-order points and nothing else", () => {
    // The 8-torsion of edwards25519 has exactly 8 elements: 8 distinct points of order dividing 8
    // among the encodings means the list is complete.
    const points = new Set<string>();
    for (const raw of SMALL_ORDER_ENCODINGS) {
      const pt = ed.Point.fromBytes(raw, true);
      expect(pt.isSmallOrder()).toBe(true);
      const { x, y } = pt.toAffine();
      points.add(`${x},${y}`);
    }
    expect(points.size).toBe(8);
    const ys = new Set(SMALL_ORDER_ENCODINGS.map(raw => leInt(raw) & ((1n << 255n) - 1n)));
    expect(ys).toEqual(new Set(ED25519_SMALL_ORDER_Y));
  });
});

describe("honest envelopes", () => {
  it("still verify, and tampering still fails, for 64 random keys", () => {
    for (let i = 0; i < 64; i++) {
      const secret = bytesToHex(randomBytes(32));
      const env = signEnvelope(bodyWith(i), secret);
      expect(ed25519PointProblem(hexToBytes(env.sig.pub))).toBeNull();
      expect(ed25519PointProblem(hexToBytes(env.sig.value).subarray(0, 32))).toBeNull();
      expect(verifyEnvelope(env)).toBe(true);
      expect(verifyEnvelope({ ...env, data: { content: "other" } })).toBe(false);
    }
  });
});

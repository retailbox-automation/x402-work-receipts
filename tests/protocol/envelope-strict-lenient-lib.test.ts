/**
 * Defence in depth: `verifyEnvelope`'s own key and R checks must hold even if
 * the library ran its lenient default (ZIP-215) — for example after a version
 * bump or a dropped `{ zip215: false }`. Here @noble/ed25519's `verify` is
 * replaced by one that always uses `zip215: true`, so every refusal below
 * comes from `ed25519PointProblem`, not from the library.
 */
import * as ed from "@noble/ed25519";
import { bytesToHex, randomBytes } from "@noble/hashes/utils.js";
import { describe, expect, it, vi } from "vitest";
import { signEnvelope, verifyEnvelope } from "../../protocol/envelope.js";
import type { Envelope } from "../../protocol/types.js";

vi.mock("@noble/ed25519", async importOriginal => {
  const mod = await importOriginal<typeof import("@noble/ed25519")>();
  return {
    ...mod,
    verify: (sig: Uint8Array, msg: Uint8Array, pub: Uint8Array) => mod.verify(sig, msg, pub, { zip215: true }),
  };
});

const P = 2n ** 255n - 19n;

function enc(y: bigint, sign = 0): Uint8Array {
  const v = y | (BigInt(sign) << 255n);
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = Number((v >> BigInt(8 * i)) & 0xffn);
  return out;
}

const IDENTITY = enc(1n);
const BASEPOINT = ed.Point.BASE.toBytes();

function forged(pub: Uint8Array, sigR: Uint8Array, sigS: Uint8Array, n: string): Envelope<unknown> {
  const sig = new Uint8Array(64);
  sig.set(sigR);
  sig.set(sigS, 32);
  return {
    schema: "mandate.v1",
    from: "anyone",
    thread_id: "t",
    data: { content: n },
    sig: { alg: "ed25519", pub: bytesToHex(pub), value: bytesToHex(sig) },
  } as Envelope<unknown>;
}

describe("with a lenient library", () => {
  it("the mock really is lenient (must-differ)", () => {
    // R = B, S = 1 under the identity key verifies in ZIP-215 mode over any message, even when
    // the caller asks for the strict branch.
    const sig = new Uint8Array(64);
    sig.set(BASEPOINT);
    sig.set(enc(1n), 32);
    expect(ed.verify(sig, new Uint8Array([1, 2, 3]), IDENTITY, { zip215: false })).toBe(true);
  });

  it("the key check alone refuses the identity-key forgery with an ordinary R", () => {
    for (const n of ["a", "b"]) expect(verifyEnvelope(forged(IDENTITY, BASEPOINT, enc(1n), n))).toBe(false);
  });

  it("the checks refuse the Capsule vector and a non-canonical identity key", () => {
    expect(verifyEnvelope(forged(IDENTITY, IDENTITY, enc(0n), "a"))).toBe(false);
    expect(verifyEnvelope(forged(enc(P + 1n), BASEPOINT, enc(1n), "a"))).toBe(false);
  });

  it("honest envelopes still verify", () => {
    for (let i = 0; i < 16; i++) {
      const env = signEnvelope({ schema: "mandate.v1", from: "a", thread_id: "t", data: { i } } as never,
        bytesToHex(randomBytes(32)));
      expect(verifyEnvelope(env)).toBe(true);
    }
  });
});

/**
 * Ed25519 envelopes.
 *
 * A signature is taken over the canonical body *without* `sig`; the envelope
 * hash that gets anchored is taken over the canonical envelope *with* `sig`
 * ("as signed", spec section 4.2). Keeping the two apart is what lets a third
 * party check both the signature and the anchor from the envelope alone.
 */
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { canonicalize, sha256Hex } from "./canonical.js";
import type { Envelope } from "./types.js";

// @noble/ed25519 keeps the synchronous API unwired until a SHA-512 is provided.
ed.hashes.sha512 = sha512;

/** Ed25519 secret keys are 32 bytes, public keys 32 bytes, signatures 64. */
const SECRET_KEY_HEX_LENGTH = 64;
const PUBLIC_KEY_HEX_LENGTH = 64;
const SIGNATURE_HEX_LENGTH = 128;

/** The field prime of edwards25519, 2^255 - 19. */
const ED25519_P = 2n ** 255n - 19n;

/**
 * Ed25519 points of small order (1, 2, 4, 8), by y coordinate: the blocklist
 * of libsodium's `ge25519_has_small_order`, including the non-canonical
 * encodings of 0 and 1 (p and p + 1). The sign bit of x is ignored, so these
 * seven values cover all eight points. Under a small-order public key the
 * signature R = identity, S = 0 satisfies the verify equation for ANY
 * message — @noble/ed25519 accepts it by default (ZIP-215), and so does
 * OpenSSL 4.0 — which makes the key one anyone can sign with.
 */
const ED25519_SMALL_ORDER_Y: ReadonlySet<bigint> = new Set([
  0n,
  1n,
  ED25519_P - 1n,
  ED25519_P,
  ED25519_P + 1n,
  2707385501144840649318225287225658788936804267575313519463743609750303402022n,
  55188659117513257062467267217118295137698188065244968500265048394206261417927n,
]);

/**
 * Says why 32 bytes are not an acceptable Ed25519 public key or signature R.
 *
 * Accepted: a canonical encoding (y < p) of a point that is not of small
 * order and lies in the prime-order subgroup — an honest key (aB) and an
 * honest R (rB) always do. The library's verify equation is cofactored, so it
 * ignores a torsion component: without the subgroup check a key's owner could
 * sign with R = rB + T or under a key aB + T, which libsodium refuses. Applied
 * to the key and to the R half of every signature before the library verifies,
 * so the check does not depend on the library's options.
 *
 * @param bytes - Candidate point encoding
 * @returns "length", "small-order", "non-canonical", "not-a-point" or "torsion"; null when acceptable
 */
export function ed25519PointProblem(
  bytes: Uint8Array,
): "length" | "small-order" | "non-canonical" | "not-a-point" | "torsion" | null {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 32) return "length";
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(i === 31 ? bytes[i] & 0x7f : bytes[i]);
  if (ED25519_SMALL_ORDER_Y.has(y)) return "small-order";
  if (y >= ED25519_P) return "non-canonical";
  let point: ed.Point;
  try {
    point = ed.Point.fromBytes(bytes, false);
  } catch {
    return "not-a-point";
  }
  if (!point.isTorsionFree()) return "torsion";
  return null;
}

/**
 * Derives the public key of an Ed25519 secret key.
 *
 * @param privateKeyHex - 32-byte secret key as hex
 * @returns The public key as lowercase hex
 * @throws If the key is not 32 bytes of hex
 */
export function publicKeyHex(privateKeyHex: string): string {
  return bytesToHex(ed.getPublicKey(secretKeyBytes(privateKeyHex)));
}

/**
 * Signs an envelope body and returns the complete envelope.
 *
 * The signature covers `canonicalize(body)`, so it is independent of key order
 * and of how the body was built. The body is not modified.
 *
 * @param body - Envelope without its signature
 * @param privateKeyHex - Signer's 32-byte Ed25519 secret key as hex
 * @returns The signed envelope
 * @throws If the key is not 32 bytes of hex
 */
export function signEnvelope<T>(body: Omit<Envelope<T>, "sig">, privateKeyHex: string): Envelope<T> {
  const secretKey = secretKeyBytes(privateKeyHex);
  const message = utf8ToBytes(canonicalize(body));
  return {
    ...body,
    sig: {
      alg: "ed25519",
      pub: bytesToHex(ed.getPublicKey(secretKey)),
      value: bytesToHex(ed.sign(message, secretKey)),
    },
  };
}

/**
 * Checks an envelope's signature against the public key it carries.
 *
 * Malformed envelopes are a failed verification, not an exception, so callers
 * can treat any untrusted input the same way. A small-order, non-canonical or
 * mixed-order key or R is refused before verifying (see `ed25519PointProblem`), and the
 * library runs its strict RFC 8032 branch (`zip215: false`).
 *
 * @param env - The envelope to check
 * @returns True when the signature covers the canonical body
 */
export function verifyEnvelope(env: Envelope<unknown>): boolean {
  try {
    const { sig, ...body } = env;
    if (!sig || sig.alg !== "ed25519") return false;
    if (!isHex(sig.pub, PUBLIC_KEY_HEX_LENGTH) || !isHex(sig.value, SIGNATURE_HEX_LENGTH)) return false;
    const pub = toBytes(sig.pub);
    const value = toBytes(sig.value);
    if (ed25519PointProblem(pub) !== null || ed25519PointProblem(value.subarray(0, 32)) !== null) return false;
    const message = utf8ToBytes(canonicalize(body));
    return ed.verify(value, message, pub, { zip215: false });
  } catch {
    return false;
  }
}

/**
 * Hashes an envelope as signed: SHA-256 over the canonical envelope including
 * `sig`. This is the value anchored on the consensus topic and referenced by
 * `receipt.mandate_envelope_hash`.
 *
 * @param env - A signed envelope
 * @returns Lowercase hex digest, 64 characters
 */
export function envelopeHash(env: Envelope<unknown>): string {
  return sha256Hex(canonicalize(env));
}

/**
 * Decodes a secret key and rejects anything that is not 32 bytes of hex.
 *
 * @param privateKeyHex - Candidate key
 * @returns The key bytes
 * @throws If the key is not 32 bytes of hex
 */
function secretKeyBytes(privateKeyHex: string): Uint8Array {
  if (!isHex(privateKeyHex, SECRET_KEY_HEX_LENGTH)) {
    throw new Error("Ed25519 secret key must be 32 bytes of hex");
  }
  return toBytes(privateKeyHex);
}

/**
 * Decodes hex of either case into bytes.
 *
 * @param hex - Hex string of even length
 * @returns The decoded bytes
 */
function toBytes(hex: string): Uint8Array {
  return hexToBytes(hex.toLowerCase());
}

/**
 * Reports whether a string is hex of an exact length, in either case.
 *
 * @param value - Candidate string
 * @param length - Required number of hex characters
 * @returns True when the string matches
 */
function isHex(value: unknown, length: number): value is string {
  return typeof value === "string" && value.length === length && /^[0-9a-fA-F]+$/.test(value);
}

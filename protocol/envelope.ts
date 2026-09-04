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
 * can treat any untrusted input the same way.
 *
 * @param env - The envelope to check
 * @returns True when the signature covers the canonical body
 */
export function verifyEnvelope(env: Envelope<unknown>): boolean {
  try {
    const { sig, ...body } = env;
    if (!sig || sig.alg !== "ed25519") return false;
    if (!isHex(sig.pub, PUBLIC_KEY_HEX_LENGTH) || !isHex(sig.value, SIGNATURE_HEX_LENGTH)) return false;
    const message = utf8ToBytes(canonicalize(body));
    return ed.verify(toBytes(sig.value), message, toBytes(sig.pub));
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

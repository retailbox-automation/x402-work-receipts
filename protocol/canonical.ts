/**
 * Canonical JSON (RFC 8785) and SHA-256, the two primitives every hash in this
 * protocol is built from.
 *
 * Two parties must produce byte-identical serializations of the same document
 * before they can agree on a hash, so every hash in the protocol is taken over
 * `canonicalize(value)` and never over `JSON.stringify(value)`.
 */
import { canonicalize as canonicalizeJson } from "json-canonicalize";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

/**
 * Serializes a value to canonical JSON per RFC 8785.
 *
 * Object members are ordered by the UTF-16 code units of their names, numbers
 * use ES6 `Number::toString`, and only the characters JSON requires are
 * escaped. `undefined` members are dropped, as `JSON.stringify` drops them.
 *
 * @param value - Any JSON-serializable value
 * @returns The canonical serialization
 * @throws If the value contains a non-finite number (RFC 8785 section 3.2.2.3)
 */
export function canonicalize(value: unknown): string {
  return canonicalizeJson(value);
}

/**
 * Hashes a string or byte array with SHA-256.
 *
 * Strings are hashed as their UTF-8 bytes, which is what canonical JSON is.
 *
 * @param s - Input string or bytes
 * @returns Lowercase hex digest, 64 characters
 */
export function sha256Hex(s: string | Uint8Array): string {
  return bytesToHex(sha256(typeof s === "string" ? utf8ToBytes(s) : s));
}

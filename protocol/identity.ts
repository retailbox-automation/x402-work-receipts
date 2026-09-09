/**
 * HCS-14 agent identity: who signed, as a string a stranger can check.
 *
 * Until now the envelopes carried plain handles — `client-y-agent`,
 * `agency-x-agent` — which are names, not identities: nothing ties them to the
 * key that signed the document, so two different agents may pick the same
 * handle and a reader has no way to notice. HCS-14 fixes the format of an agent
 * identifier; this module implements the two targets the standard defines and
 * one property the standard makes possible:
 *
 * ```
 * uaid:did:{id};{parameters}   self-sovereign — the id is an existing W3C DID's
 *                              method-specific identifier (HCS-14 §"DID Structure")
 * uaid:aid:{id};{parameters}   registry-generated — the id is Base58(SHA-384(canonical JSON))
 *                              over six agent fields (HCS-14 §"Hash Generation")
 * ```
 *
 * Both agents here use the **did** target with `did:key`, because that is the
 * only one of the two that a verifier can check offline. A `did:key`
 * method-specific identifier is multibase base58btc over the multicodec prefix
 * `0xed 0x01` followed by the raw Ed25519 public key, so the identifier *is*
 * the key: decode it and compare it with the `sig.pub` of the envelope, and the
 * claim "this document came from that agent" is settled without resolving
 * anything, asking a registry, or trusting either company's directory.
 *
 * The **aid** target is implemented too, exactly as the standard specifies it,
 * because a receipt may name a counterparty that has no DID. It is derived from
 * six descriptive fields rather than from a key, so it can be recomputed by
 * anyone who holds those fields — and it cannot, by construction, be checked
 * against a signature. The verifier says so rather than pretending otherwise.
 *
 * Spec: `hiero-ledger/hiero-consensus-specifications`,
 * `docs/standards/hcs-14/index.md` (Draft) — sections cited per function.
 */
import { base58 } from "@scure/base";
import { sha384 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { canonicalize } from "./canonical.js";

/** Scheme prefix of every identifier this module reads or writes. */
export const UAID_SCHEME = "uaid";

/** The two targets HCS-14 defines: a derived hash, or an existing DID. */
export type UaidTarget = "aid" | "did";

/**
 * Emission order of the routing parameters.
 *
 * HCS-14 §"DID Parameter Structure": "Parameters are ordered with `uid` first,
 * followed by `registry`, `proto`, `nativeId`, and `domain` (if present).
 * Implementations shall preserve this order when emitting UAIDs." `src` is
 * optional and only appears when a base DID had to be sanitized, so it goes
 * last. Order is enforced on the way out and not required on the way in: a
 * counterparty that emits them in another order is out of spec, but its
 * identifier still says exactly which key signed, and refusing to read it would
 * turn a formatting slip into a failed verification.
 */
export const UAID_PARAM_ORDER = ["uid", "registry", "proto", "nativeId", "domain", "src"] as const;

/** Routing parameters of an identifier. `uid` is required and defaults to `0`. */
export type UaidParams = {
  /** Unique id within the registry; "shall be '0' if not applicable". */
  uid?: string;
  /** Registry namespace, e.g. `hol`, `nanda`; `self` when there is none. */
  registry?: string;
  /** Protocol code from the standard's list, e.g. `rest`, `a2a`, `hcs-10`. */
  proto?: string;
  /** The protocol's native id; CAIP-10 for chains, e.g. `hedera:testnet:0.0.5`. */
  nativeId?: string;
  /** Domain of the agent, when it has one. */
  domain?: string;
  /** Multibase base58btc of the full base DID, when sanitization dropped part of it. */
  src?: string;
};

/** A parsed identifier. */
export type Uaid = {
  target: UaidTarget;
  /** The id component: a `did:key` identifier, or a Base58 hash for `aid`. */
  id: string;
  /** Routing parameters, in the order they appeared. */
  params: Record<string, string>;
  /** The identifier as it was given. */
  text: string;
};

/**
 * The six fields an `aid` is derived from.
 *
 * HCS-14 §"Canonical Agent Data": endpoints, topic ids and platform
 * capabilities are deliberately not among them, so an agent that moves house
 * keeps its identifier.
 */
export type CanonicalAgentData = {
  /** Registry namespace; `self` for an agent that belongs to none. */
  registry: string;
  name: string;
  /** Semantic version, e.g. `1.0.0`. */
  version: string;
  /** Protocol code. */
  protocol: string;
  /** The protocol's native unique id. */
  nativeId: string;
  /** Capability enums, `0-39` or `100+`; `40-99` are reserved and rejected. */
  skills?: number[];
};

/** Multicodec prefix of an Ed25519 public key inside a `did:key` identifier. */
export const DID_KEY_ED25519_PREFIX = Uint8Array.of(0xed, 0x01);

/** Multibase tag for base58btc, the encoding `did:key` uses. */
const MULTIBASE_BASE58BTC = "z";

/** Raw Ed25519 public keys are 32 bytes. */
const PUBLIC_KEY_BYTES = 32;

/** Reserved skill range; HCS-14 §"Implementation Requirements" 6 rejects it. */
const RESERVED_SKILLS = { from: 40, to: 99 };

/** Characters that terminate the id component of an identifier. */
const ID_TERMINATORS = [";", "?", "#"];

/**
 * The `did:key` identifier of an Ed25519 public key.
 *
 * `z` + base58btc(`0xed 0x01` ‖ key), which is what makes the identifier
 * self-certifying: the key can be read straight back out of it.
 *
 * @param publicKeyHex - 32-byte Ed25519 public key as hex
 * @returns The method-specific identifier, e.g. `z6Mkha…`
 * @throws When the key is not 32 bytes of hex
 */
export function didKeyFromPublicKey(publicKeyHex: string): string {
  const key = publicKeyBytes(publicKeyHex);
  const bytes = new Uint8Array(DID_KEY_ED25519_PREFIX.length + key.length);
  bytes.set(DID_KEY_ED25519_PREFIX, 0);
  bytes.set(key, DID_KEY_ED25519_PREFIX.length);
  return MULTIBASE_BASE58BTC + base58.encode(bytes);
}

/**
 * The Ed25519 public key inside a `did:key` identifier.
 *
 * Anything that is not an Ed25519 `did:key` — another key type, another DID
 * method, rubbish — returns null rather than throwing: this runs over strings
 * copied out of untrusted documents.
 *
 * @param id - A method-specific identifier, with or without a `did:key:` prefix
 * @returns The public key as lowercase hex, or null when the id carries none
 */
export function publicKeyFromDidKey(id: string): string | null {
  const body = id.startsWith("did:key:") ? id.slice("did:key:".length) : id;
  if (!body.startsWith(MULTIBASE_BASE58BTC)) {
    return null;
  }
  let bytes: Uint8Array;
  try {
    bytes = base58.decode(body.slice(1));
  } catch {
    return null;
  }
  if (bytes.length !== DID_KEY_ED25519_PREFIX.length + PUBLIC_KEY_BYTES) {
    return null;
  }
  if (bytes[0] !== DID_KEY_ED25519_PREFIX[0] || bytes[1] !== DID_KEY_ED25519_PREFIX[1]) {
    return null;
  }
  return bytesToHex(bytes.slice(DID_KEY_ED25519_PREFIX.length));
}

/**
 * The identifier an agent publishes for itself, from the key it signs with.
 *
 * HCS-14 §"Self-Sovereign Identifiers (UAID Targeting a DID)": the id is the
 * base DID's method-specific identifier and no new hash is computed.
 *
 * @param publicKeyHex - The agent's 32-byte Ed25519 public key as hex
 * @param params - Routing parameters; `uid` defaults to `0` as the standard requires
 * @returns The identifier, e.g. `uaid:did:z6Mkha…;uid=0;registry=self;proto=rest`
 * @throws When the key is not 32 bytes of hex, or a parameter value is unusable
 */
export function uaidFromPublicKey(publicKeyHex: string, params: UaidParams = {}): string {
  return formatUaid("did", didKeyFromPublicKey(publicKeyHex), params);
}

/**
 * The `aid` identifier of an agent, derived from its six canonical fields.
 *
 * HCS-14 §"Hash Generation", steps 1-6: validate, normalize (lowercase
 * `registry` and `protocol`, trim every string), sort skills numerically and
 * keys lexicographically, serialize to canonical JSON, SHA-384 over UTF-8,
 * Base58. The serialization is this repository's RFC 8785 canonicalizer, which
 * orders keys lexicographically and is what every other hash here is taken
 * over; for the six ASCII fields it is byte for byte what the standard's
 * reference `JSON.stringify(canonical, Object.keys(canonical).sort())` produces.
 *
 * @param agent - The six canonical fields
 * @param params - Routing parameters; `uid` defaults to `0`
 * @returns The identifier, e.g. `uaid:aid:5J8…;uid=0;registry=hol;…`
 * @throws When a required field is missing or a skill is in the reserved range
 */
export function deriveAid(agent: CanonicalAgentData, params: UaidParams = {}): string {
  const digest = sha384(utf8ToBytes(canonicalAgentJson(agent)));
  return formatUaid("aid", base58.encode(digest), params);
}

/**
 * The canonical JSON an `aid` is hashed over.
 *
 * Exposed on its own because the bytes that go into an identifier are the part
 * two implementations have to agree on, and a test that compares hashes without
 * being able to compare their input tells you nothing about why they differ.
 *
 * @param agent - The six canonical fields
 * @returns The canonical serialization
 * @throws When a required field is empty or a skill is reserved or not a whole number
 */
export function canonicalAgentJson(agent: CanonicalAgentData): string {
  const required: Array<[keyof CanonicalAgentData, unknown]> = [
    ["registry", agent.registry],
    ["name", agent.name],
    ["version", agent.version],
    ["protocol", agent.protocol],
    ["nativeId", agent.nativeId],
  ];
  for (const [field, value] of required) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`HCS-14 canonical agent data needs a non-empty ${String(field)}`);
    }
  }

  const skills = [...(agent.skills ?? [])];
  for (const skill of skills) {
    if (!Number.isInteger(skill) || skill < 0) {
      throw new Error(`HCS-14 skills are whole numbers, got ${String(skill)}`);
    }
    if (skill >= RESERVED_SKILLS.from && skill <= RESERVED_SKILLS.to) {
      throw new Error(
        `HCS-14 skill ${skill} is in the reserved range ${RESERVED_SKILLS.from}-${RESERVED_SKILLS.to} and must be rejected`,
      );
    }
  }

  return canonicalize({
    registry: agent.registry.trim().toLowerCase(),
    name: agent.name.trim(),
    version: agent.version.trim(),
    protocol: agent.protocol.trim().toLowerCase(),
    nativeId: agent.nativeId.trim(),
    skills: skills.sort((left, right) => left - right),
  });
}

/**
 * Parses an identifier, or reports that it is not one.
 *
 * @param value - Candidate string, e.g. an envelope's `from`
 * @returns The parsed identifier, or null when the string is not a well-formed one
 */
export function parseUaid(value: unknown): Uaid | null {
  if (typeof value !== "string") {
    return null;
  }
  const parts = value.split(";");
  const head = parts[0] ?? "";
  const segments = head.split(":");
  if (segments.length < 3 || segments[0] !== UAID_SCHEME) {
    return null;
  }
  const target = segments[1];
  if (target !== "aid" && target !== "did") {
    return null;
  }
  // The id may itself contain colons (`did:key:z…` reduced to `z…` keeps none,
  // but other DID methods do), so everything after the target is the id.
  const id = segments.slice(2).join(":");
  if (id.length === 0 || ID_TERMINATORS.some(char => id.includes(char))) {
    return null;
  }

  const params: Record<string, string> = {};
  for (const part of parts.slice(1)) {
    const equals = part.indexOf("=");
    if (equals <= 0) {
      return null;
    }
    const key = part.slice(0, equals);
    const parameterValue = part.slice(equals + 1);
    if (parameterValue.length === 0 || key in params) {
      return null;
    }
    params[key] = parameterValue;
  }

  return { target, id, params, text: value };
}

/**
 * Whether a string is a well-formed identifier.
 *
 * @param value - Candidate string
 * @returns True when {@link parseUaid} can read it
 */
export function isUaid(value: unknown): boolean {
  return parseUaid(value) !== null;
}

/**
 * What is wrong with an identifier, in the standard's terms.
 *
 * Only requirements the standard states with "shall" are reported, and only
 * ones a reader can check from the string alone. Parameter order is not among
 * them: it binds emitters, and rejecting a counterparty's identifier over the
 * order of two routing hints would be reading the standard against its purpose.
 *
 * @param value - Candidate string
 * @returns The problems; empty when the identifier is in order
 */
export function uaidProblems(value: unknown): string[] {
  const parsed = parseUaid(value);
  if (!parsed) {
    return [`not a well-formed uaid: ${describe(value)}`];
  }
  const problems: string[] = [];
  if (!parsed.params["uid"]) {
    problems.push('the uid parameter is required and shall be "0" if not applicable');
  }
  if (parsed.target === "did" && parsed.id.startsWith(MULTIBASE_BASE58BTC)) {
    if (publicKeyFromDidKey(parsed.id) === null && parsed.id.startsWith("z6Mk")) {
      problems.push("the did:key identifier does not decode to an Ed25519 public key");
    }
  }
  return problems;
}

/**
 * The public key an identifier commits to, when it commits to one.
 *
 * Only the `did` target over `did:key` does. An `aid` is a hash of descriptive
 * fields and a `did` over any other method needs resolution, so both return
 * null — "I cannot decide this here", which is a different answer from "this
 * does not match".
 *
 * @param value - An identifier or an already parsed one
 * @returns The public key as lowercase hex, or null when the identifier names none
 */
export function publicKeyForUaid(value: string | Uaid | null): string | null {
  const parsed = typeof value === "string" ? parseUaid(value) : value;
  if (!parsed || parsed.target !== "did") {
    return null;
  }
  return publicKeyFromDidKey(parsed.id);
}

/**
 * Whether an identifier is the one this key produces.
 *
 * @param value - The identifier claimed by a document
 * @param publicKeyHex - The key that signed the document
 * @returns True when the identifier decodes to exactly that key
 */
export function uaidMatchesPublicKey(value: string | Uaid | null, publicKeyHex: string): boolean {
  const committed = publicKeyForUaid(value);
  return committed !== null && committed === publicKeyHex.trim().toLowerCase();
}

/**
 * A CAIP-10 style native id for a Hedera account.
 *
 * HCS-14 §"DID Parameter Structure" asks for CAIP-10 where applicable:
 * `hedera:<network>:<account>`.
 *
 * @param network - `hedera:testnet`, `hedera:mainnet`, `testnet` or `mainnet`
 * @param accountId - Hedera account id, `0.0.x`
 * @returns The native id, or undefined when the account is missing
 */
export function hederaNativeId(network: string, accountId?: string): string | undefined {
  const account = accountId?.trim();
  if (!account) {
    return undefined;
  }
  const name = network.trim().toLowerCase().replace(/^hedera:/, "");
  return `hedera:${name}:${account}`;
}

/**
 * Assembles an identifier from its parts, in the standard's parameter order.
 *
 * @param target - `aid` or `did`
 * @param id - The id component
 * @param params - Routing parameters; `uid` defaults to `0`
 * @returns The identifier
 * @throws When a parameter value contains a character that would break parsing
 */
function formatUaid(target: UaidTarget, id: string, params: UaidParams): string {
  const values: Record<string, string | undefined> = { ...params, uid: params.uid ?? "0" };
  const pairs: string[] = [];
  for (const key of UAID_PARAM_ORDER) {
    const value = values[key]?.trim();
    if (!value) {
      continue;
    }
    if (value.includes(";") || value.includes("=")) {
      throw new Error(`HCS-14 parameter ${key} may not contain ";" or "=", got "${value}"`);
    }
    pairs.push(`${key}=${value}`);
  }
  return [`${UAID_SCHEME}:${target}:${id}`, ...pairs].join(";");
}

/**
 * Decodes a public key and rejects anything that is not 32 bytes of hex.
 *
 * @param publicKeyHex - Candidate key
 * @returns The key bytes
 * @throws When the key is not 32 bytes of hex
 */
function publicKeyBytes(publicKeyHex: string): Uint8Array {
  const hex = publicKeyHex.trim().toLowerCase();
  if (hex.length !== PUBLIC_KEY_BYTES * 2 || !/^[0-9a-f]+$/.test(hex)) {
    throw new Error("Ed25519 public key must be 32 bytes of hex");
  }
  return hexToBytes(hex);
}

/**
 * Renders an unusable value for an error message, without printing all of it.
 *
 * @param value - The value
 * @returns A short description
 */
function describe(value: unknown): string {
  if (typeof value !== "string") {
    return typeof value;
  }
  return value.length <= 48 ? `"${value}"` : `"${value.slice(0, 45)}…"`;
}

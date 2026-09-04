/**
 * Ed25519 envelopes: sign over the canonical body, verify, hash "as signed".
 *
 * The key pair is RFC 8032 section 7.1 test 1, so the vectors are checkable
 * against the standard rather than against this implementation.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalize, sha256Hex } from "../../protocol/canonical.js";
import { envelopeHash, publicKeyHex, signEnvelope, verifyEnvelope } from "../../protocol/envelope.js";
import { validateMandate } from "../../protocol/schemas.js";
import type { Envelope } from "../../protocol/types.js";

const PRIVATE_KEY = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const PUBLIC_KEY = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";

type Payload = { mandate_id: string; title: string };

const body: Omit<Envelope<Payload>, "sig"> = {
  schema: "mandate.v1",
  from: "client-y-pm",
  to: "agency-x",
  thread_id: "0192c3f0-5b7e-7a10-9d2e-6f1a2b3c4d5e",
  issued_at: "2026-09-05T14:00:00Z",
  data: { mandate_id: "0192c3f0-5b7e-7a10-9d2e-6f1a2b3c4d5e", title: "Group trades by day" },
};

describe("publicKeyHex", () => {
  it("derives the RFC 8032 test-1 public key", () => {
    expect(publicKeyHex(PRIVATE_KEY)).toBe(PUBLIC_KEY);
  });
});

describe("signEnvelope", () => {
  it("returns the body plus an ed25519 signature carrying the public key", () => {
    const env = signEnvelope(body, PRIVATE_KEY);
    expect(env.sig.alg).toBe("ed25519");
    expect(env.sig.pub).toBe(PUBLIC_KEY);
    expect(env.sig.value).toMatch(/^[0-9a-f]{128}$/);
    expect(env.data).toEqual(body.data);
    expect(env.thread_id).toBe(body.thread_id);
  });

  it("is deterministic and independent of key insertion order", () => {
    const reordered = {
      data: body.data,
      issued_at: body.issued_at,
      thread_id: body.thread_id,
      to: body.to,
      from: body.from,
      schema: body.schema,
    } as Omit<Envelope<Payload>, "sig">;
    expect(signEnvelope(reordered, PRIVATE_KEY).sig.value).toBe(signEnvelope(body, PRIVATE_KEY).sig.value);
  });

  it("does not mutate the body it is given", () => {
    const input = { ...body };
    signEnvelope(input, PRIVATE_KEY);
    expect("sig" in input).toBe(false);
  });

  it("rejects a private key that is not 32 bytes of hex", () => {
    expect(() => signEnvelope(body, "abcd")).toThrow();
  });
});

describe("verifyEnvelope", () => {
  it("accepts an envelope it signed", () => {
    expect(verifyEnvelope(signEnvelope(body, PRIVATE_KEY))).toBe(true);
  });

  it("rejects an envelope whose data changed by one byte", () => {
    const env = signEnvelope(body, PRIVATE_KEY);
    const tampered = { ...env, data: { ...env.data, title: "Group trades by dax" } };
    expect(verifyEnvelope(tampered)).toBe(false);
  });

  it("rejects a changed header field", () => {
    const env = signEnvelope(body, PRIVATE_KEY);
    expect(verifyEnvelope({ ...env, to: "agency-z" })).toBe(false);
  });

  it("rejects a field appended to the envelope after signing", () => {
    const env = signEnvelope(body, PRIVATE_KEY);
    const extended = { ...env, note: "added later" } as unknown as Envelope<Payload>;
    expect(verifyEnvelope(extended)).toBe(false);
  });

  it("rejects a flipped signature byte, a foreign public key and a wrong algorithm", () => {
    const env = signEnvelope(body, PRIVATE_KEY);
    const flipped = env.sig.value.slice(0, 10) + (env.sig.value[10] === "0" ? "1" : "0") + env.sig.value.slice(11);
    expect(verifyEnvelope({ ...env, sig: { ...env.sig, value: flipped } })).toBe(false);
    const foreign = publicKeyHex("4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb");
    expect(verifyEnvelope({ ...env, sig: { ...env.sig, pub: foreign } })).toBe(false);
    expect(verifyEnvelope({ ...env, sig: { ...env.sig, alg: "rsa" as unknown as "ed25519" } })).toBe(false);
  });

  it("returns false instead of throwing on a malformed signature block", () => {
    const env = signEnvelope(body, PRIVATE_KEY);
    expect(verifyEnvelope({ ...env, sig: { ...env.sig, value: "not-hex" } })).toBe(false);
    expect(verifyEnvelope({ ...env, sig: { ...env.sig, pub: "" } })).toBe(false);
    expect(verifyEnvelope({ ...env, sig: undefined as unknown as Envelope<unknown>["sig"] })).toBe(false);
  });

  it("verifies the signature over the canonical body without sig", () => {
    const env = signEnvelope(body, PRIVATE_KEY);
    const { sig: _sig, ...signedBody } = env;
    expect(canonicalize(signedBody)).toBe(canonicalize(body));
  });
});

describe("a real mandate travelling in an envelope", () => {
  it("validates, signs, verifies and yields an anchorable hash", () => {
    const mandate = JSON.parse(
      readFileSync(new URL("../../docs/schemas/examples/mandate.v1.example.json", import.meta.url), "utf8"),
    ) as unknown;
    validateMandate(mandate);
    const env = signEnvelope(
      {
        schema: "mandate.v1",
        from: mandate.issuer,
        to: "agency-x",
        thread_id: mandate.mandate_id,
        issued_at: mandate.issued_at,
        data: mandate,
      },
      PRIVATE_KEY,
    );
    expect(verifyEnvelope(env)).toBe(true);
    expect(envelopeHash(env)).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyEnvelope({ ...env, data: { ...env.data, title: env.data.title + "." } })).toBe(false);
  });
});

describe("envelopeHash", () => {
  it("hashes the canonical envelope including the signature", () => {
    const env = signEnvelope(body, PRIVATE_KEY);
    expect(envelopeHash(env)).toBe(sha256Hex(canonicalize(env)));
    expect(envelopeHash(env)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when the signature changes", () => {
    const env = signEnvelope(body, PRIVATE_KEY);
    const other = signEnvelope(body, "4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb");
    expect(other.sig.value).not.toBe(env.sig.value);
    expect(envelopeHash(other)).not.toBe(envelopeHash(env));
  });

  it("differs from the hash of the unsigned body", () => {
    const env = signEnvelope(body, PRIVATE_KEY);
    expect(envelopeHash(env)).not.toBe(sha256Hex(canonicalize(body)));
  });

  it("is stable across key insertion order", () => {
    const env = signEnvelope(body, PRIVATE_KEY);
    const reordered = { sig: env.sig, data: env.data, to: env.to, from: env.from, schema: env.schema, thread_id: env.thread_id, issued_at: env.issued_at };
    expect(envelopeHash(reordered)).toBe(envelopeHash(env));
  });
});

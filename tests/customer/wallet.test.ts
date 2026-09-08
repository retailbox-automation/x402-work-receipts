/**
 * Configuration of the customer agent: who it signs as, which account pays,
 * and how much a single x402 payment is allowed to move.
 */
import { describe, expect, it } from "vitest";
import {
  ConfigError,
  DEFAULT_MAX_AMOUNT_PER_PAYMENT,
  HBAR_ASSET,
  loadCustomerConfig,
  loadPaymentIdentity,
  loadSigningIdentity,
} from "../../customer/wallet";

/** 32 bytes of hex, a syntactically valid Ed25519 secret key. */
const SIGNING_KEY = "11".repeat(32);
/** Shape of an ECDSA key as the spike writes it into `.env`. */
const PAYER_KEY = "302e020100300506032b657004220420" + "22".repeat(16);

/**
 * A minimal environment with everything the customer needs.
 *
 * @param overrides - Values to add or replace
 * @returns The environment
 */
function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    CUSTOMER_SIGNING_KEY: SIGNING_KEY,
    CUSTOMER_ACCOUNT_ID: "0.0.10365982",
    CUSTOMER_PRIVATE_KEY: PAYER_KEY,
    ...overrides,
  };
}

describe("signing identity", () => {
  it("derives the public key from the secret key", () => {
    const identity = loadSigningIdentity(env());
    expect(identity.privateKeyHex).toBe(SIGNING_KEY);
    expect(identity.publicKeyHex).toMatch(/^[0-9a-f]{64}$/);
  });

  it("defaults the handle and the counterparty and lets both be overridden", () => {
    const identity = loadSigningIdentity(env());
    expect(identity.handle).toMatch(/^[a-z0-9][a-z0-9-]{2,31}$/);
    expect(identity.agent).toBe(identity.handle);
    expect(identity.counterparty).not.toBe(identity.handle);

    const named = loadSigningIdentity(env({ CUSTOMER_HANDLE: "client-y", CONTRACTOR_AGENT: "agency-x" }));
    expect(named.handle).toBe("client-y");
    expect(named.counterparty).toBe("agency-x");
  });

  it("rejects a handle the mandate schema would reject", () => {
    expect(() => loadSigningIdentity(env({ CUSTOMER_HANDLE: "Client Y" }))).toThrow(ConfigError);
  });

  it("rejects a secret key that is not 32 bytes of hex", () => {
    expect(() => loadSigningIdentity(env({ CUSTOMER_SIGNING_KEY: "abcd" }))).toThrow(ConfigError);
  });

  it("names the missing variable and how to produce it", () => {
    expect(() => loadSigningIdentity(env({ CUSTOMER_SIGNING_KEY: undefined }))).toThrow(
      /CUSTOMER_SIGNING_KEY/,
    );
  });
});

describe("payment identity", () => {
  it("pays HBAR on testnet with the configured cap", () => {
    const payment = loadPaymentIdentity(env({ CUSTOMER_MAX_TINYBARS_PER_PAYMENT: "2500000" }));
    expect(payment.network).toBe("hedera:testnet");
    expect(payment.asset).toBe(HBAR_ASSET);
    expect(payment.accountId).toBe("0.0.10365982");
    expect(payment.maxAmountPerPayment).toBe("2500000");
  });

  it("falls back to the spike payer account when no customer account is set", () => {
    const payment = loadPaymentIdentity(
      env({
        CUSTOMER_ACCOUNT_ID: undefined,
        CUSTOMER_PRIVATE_KEY: undefined,
        PAYER_ACCOUNT_ID: "0.0.7777777",
        PAYER_PRIVATE_KEY: PAYER_KEY,
      }),
    );
    expect(payment.accountId).toBe("0.0.7777777");
    expect(payment.privateKeyHex).toBe(PAYER_KEY);
  });

  it("uses the default cap when none is configured", () => {
    expect(loadPaymentIdentity(env()).maxAmountPerPayment).toBe(DEFAULT_MAX_AMOUNT_PER_PAYMENT);
  });

  it("rejects a cap that is not a positive whole number of tinybars", () => {
    expect(() => loadPaymentIdentity(env({ CUSTOMER_MAX_TINYBARS_PER_PAYMENT: "0.5" }))).toThrow(ConfigError);
    expect(() => loadPaymentIdentity(env({ CUSTOMER_MAX_TINYBARS_PER_PAYMENT: "0" }))).toThrow(ConfigError);
  });

  it("rejects an account id that is not a Hedera account", () => {
    expect(() => loadPaymentIdentity(env({ CUSTOMER_ACCOUNT_ID: "0xabc" }))).toThrow(ConfigError);
  });

  it("reads the network and the facilitator from the environment", () => {
    const payment = loadPaymentIdentity(
      env({ HEDERA_NETWORK: "mainnet", X402_FACILITATOR_URL: "https://facilitator.example.com" }),
    );
    expect(payment.network).toBe("hedera:mainnet");
    expect(payment.facilitator).toBe("https://facilitator.example.com");
  });
});

describe("customer configuration", () => {
  it("carries the contractor url and the output directory", () => {
    const config = loadCustomerConfig(env({ CONTRACTOR_URL: "http://localhost:4022", CUSTOMER_OUT_DIR: "tmp-out" }));
    expect(config.contractorUrl).toBe("http://localhost:4022");
    expect(config.outDir).toBe("tmp-out");
    expect(config.signing.publicKeyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(config.payment.asset).toBe(HBAR_ASSET);
  });
});

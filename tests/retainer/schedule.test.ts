/**
 * The guards around creating a retainer, and the configuration behind the
 * command.
 *
 * Everything here runs before a client is touched, which is the point: a
 * retainer that is refused locally costs nothing, while one the network refuses
 * has already cost a transaction fee — and a retainer created with the wrong
 * amount or an expiry a month away is money the customer cannot easily get back.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_RETAINER_TINYBARS,
  clientFor,
  loadRetainerConfig,
} from "../../retainer/cli";
import type { Client } from "@hiero-ledger/sdk";
import {
  DEFAULT_EXPIRY_SECONDS,
  MAX_EXPIRY_SECONDS,
  MIN_EXPIRY_SECONDS,
  scheduleRetainer,
} from "../../retainer/schedule";

/** A client the guards must never reach for; any use of it throws. */
const NO_CLIENT = null as unknown as Client;

/** An ECDSA key from the throwaway testnet accounts the spike created. */
const KEY = "3030020100300706052b8104000a04220420" + "11".repeat(32);

/** The smallest environment a retainer command can run in. */
function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    HEDERA_NETWORK: "testnet",
    PAYER_ACCOUNT_ID: "0.0.10365982",
    PAYER_PRIVATE_KEY: KEY,
    RECEIVER_ACCOUNT_ID: "0.0.10365984",
    RECEIVER_PRIVATE_KEY: KEY,
    ANCHOR_TOPIC_ID: "0.0.10426298",
    CUSTOMER_SIGNING_KEY: "ab".repeat(32),
    ...overrides,
  } as NodeJS.ProcessEnv;
}

describe("scheduleRetainer guards", () => {
  it("refuses an amount that is not a whole positive number of tinybars", async () => {
    for (const tinybars of [0, -1, 1.5, Number.NaN]) {
      await expect(
        scheduleRetainer(NO_CLIENT, {
          customerId: "0.0.1",
          contractorId: "0.0.2",
          tinybars,
        }),
      ).rejects.toThrow(RangeError);
    }
  });

  it("refuses a window shorter than a minute or beyond the network's 62 days", async () => {
    for (const expiresInSeconds of [MIN_EXPIRY_SECONDS - 1, MAX_EXPIRY_SECONDS + 1, 0]) {
      await expect(
        scheduleRetainer(NO_CLIENT, {
          customerId: "0.0.1",
          contractorId: "0.0.2",
          tinybars: 1_000_000,
          expiresInSeconds,
        }),
      ).rejects.toThrow(/window must be between/);
    }
  });

  it("refuses a memo the network would not store", async () => {
    await expect(
      scheduleRetainer(NO_CLIENT, {
        customerId: "0.0.1",
        contractorId: "0.0.2",
        tinybars: 1_000_000,
        memo: "x".repeat(101),
      }),
    ).rejects.toThrow(/at most 100 bytes/);
  });
});

describe("loadRetainerConfig", () => {
  it("takes the customer from the account that pays for the order", () => {
    const config = loadRetainerConfig(env());
    expect(config.customer.accountId).toBe("0.0.10365982");
    expect(config.contractor.accountId).toBe("0.0.10365984");
    expect(config.network).toBe("hedera:testnet");
    expect(config.topicId).toBe("0.0.10426298");
    expect(config.tinybars).toBe(DEFAULT_RETAINER_TINYBARS);
    expect(config.expiresInSeconds).toBe(DEFAULT_EXPIRY_SECONDS);
  });

  it("prefers the contractor's own variables over the spike's receiver account", () => {
    const config = loadRetainerConfig(
      env({ CONTRACTOR_ACCOUNT_ID: "0.0.4242", CONTRACTOR_PRIVATE_KEY: KEY }),
    );
    expect(config.contractor.accountId).toBe("0.0.4242");
  });

  it("refuses to run without the key the contractor releases with", () => {
    expect(() => loadRetainerConfig(env({ RECEIVER_PRIVATE_KEY: undefined }))).toThrow(
      /CONTRACTOR_PRIVATE_KEY/,
    );
  });

  it("refuses an account id that is not a 0.0.x account", () => {
    expect(() => loadRetainerConfig(env({ RECEIVER_ACCOUNT_ID: "0x1234" }))).toThrow(
      /CONTRACTOR_ACCOUNT_ID/,
    );
  });

  it("refuses to run without a topic to anchor to", () => {
    expect(() => loadRetainerConfig(env({ ANCHOR_TOPIC_ID: undefined }))).toThrow(/ANCHOR_TOPIC_ID/);
  });

  it("refuses an amount or a window that is not a whole positive number", () => {
    expect(() => loadRetainerConfig(env({ RETAINER_TINYBARS: "-5" }))).toThrow(/RETAINER_TINYBARS/);
    expect(() => loadRetainerConfig(env({ RETAINER_EXPIRY_SECONDS: "half an hour" }))).toThrow(
      /RETAINER_EXPIRY_SECONDS/,
    );
  });
});

describe("clientFor", () => {
  it("builds a client for either network without touching one", () => {
    const party = { accountId: "0.0.10365982", privateKeyHex: KEY, keyType: "ecdsa" };
    const testnet = clientFor("hedera:testnet", party);
    const mainnet = clientFor("hedera:mainnet", party);
    expect(testnet.operatorAccountId?.toString()).toBe("0.0.10365982");
    expect(mainnet.operatorAccountId?.toString()).toBe("0.0.10365982");
    testnet.close();
    mainnet.close();
  });
});

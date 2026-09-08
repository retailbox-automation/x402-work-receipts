/**
 * The paying side of the customer agent.
 *
 * The spend-control tests are the important ones: the Hedera scheme only knows
 * USDC as a default asset, so without an explicit HBAR opt-in every payment is
 * refused on this machine before it is ever signed (spike gotcha 1).
 */
import { describe, expect, it } from "vitest";
import { hashscanTopicUrl, hashscanTransactionUrl, spendControlsFor } from "../../customer/pay";
import { HBAR_ASSET, loadPaymentIdentity } from "../../customer/wallet";

/**
 * Payment configuration with the given per-payment cap.
 *
 * @param overrides - Environment values to replace
 * @returns The payment identity
 */
function payment(overrides: Record<string, string | undefined> = {}) {
  return loadPaymentIdentity({
    CUSTOMER_ACCOUNT_ID: "0.0.10365982",
    CUSTOMER_PRIVATE_KEY: "a".repeat(64),
    ...overrides,
  });
}

describe("spendControlsFor", () => {
  it("opts HBAR in on the configured network with the configured cap", () => {
    const controls = spendControlsFor(payment({ CUSTOMER_MAX_TINYBARS_PER_PAYMENT: "5000000" }));
    expect(controls.allowedAssets).toEqual([
      { network: "hedera:testnet", asset: HBAR_ASSET, maxAmountPerPayment: "5000000" },
    ]);
  });

  it("follows the network, so a mainnet cap never authorises a testnet payment", () => {
    const controls = spendControlsFor(payment({ HEDERA_NETWORK: "mainnet" }));
    expect(controls.allowedAssets[0]?.network).toBe("hedera:mainnet");
  });

  it("states the cap in whole tinybars, not in dollars", () => {
    const cap = spendControlsFor(payment({ CUSTOMER_MAX_TINYBARS_PER_PAYMENT: "1200000" })).allowedAssets[0]
      ?.maxAmountPerPayment;
    expect(cap).toBe("1200000");
    expect(cap).not.toMatch(/\$/);
  });
});

describe("explorer links", () => {
  it("links a transaction in the facilitator's own id form", () => {
    expect(hashscanTransactionUrl("0.0.7162784@1788539653.433840739", "hedera:testnet")).toBe(
      "https://hashscan.io/testnet/transaction/0.0.7162784@1788539653.433840739",
    );
  });

  it("accepts the mirror-node id form and links the same transaction", () => {
    expect(hashscanTransactionUrl("0.0.7162784-1788539653-433840739", "hedera:testnet")).toBe(
      "https://hashscan.io/testnet/transaction/0.0.7162784@1788539653.433840739",
    );
  });

  it("links the audit topic", () => {
    expect(hashscanTopicUrl("0.0.10366318", "hedera:testnet")).toBe(
      "https://hashscan.io/testnet/topic/0.0.10366318",
    );
  });

  it("follows the network into the explorer path", () => {
    expect(hashscanTopicUrl("0.0.10366318", "hedera:mainnet")).toContain("/mainnet/");
  });
});

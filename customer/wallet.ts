/**
 * Configuration of the customer agent — two identities, deliberately separate.
 *
 * The agent signs work orders with an Ed25519 key (the protocol identity, the
 * `issuer` handle a counterparty sees) and pays with a Hedera ECDSA account
 * (the money identity the facilitator settles from). Keeping them apart means
 * rotating a payment account never invalidates a signature on an order that has
 * already been anchored.
 *
 * Everything is read from the environment, so nothing secret is ever written
 * into a tracked file; `.env` holds the keys and is not committed.
 */
import { publicKeyHex } from "../protocol/envelope.js";

/** CAIP-2 identifier of the Hedera network payments settle on. */
export type HederaNetwork = "hedera:testnet" | "hedera:mainnet";

/** HBAR as an x402 asset id; anything else would be an HTS token. */
export const HBAR_ASSET = "0.0.0";

/** Per-payment ceiling used when the environment does not set one, in tinybars (0.05 HBAR). */
export const DEFAULT_MAX_AMOUNT_PER_PAYMENT = "5000000";

/** Facilitator that verifies and settles x402 payments on Hedera testnet. */
export const DEFAULT_FACILITATOR_URL = "https://api.testnet.blocky402.com";

/** Where the contractor service is expected to listen during the demo. */
export const DEFAULT_CONTRACTOR_URL = "http://localhost:4021";

/** Directory the agent writes one folder of artifacts per order into. */
export const DEFAULT_OUT_DIR = "out";

/** Handles are the `issuer` and `from` values, and `mandate.v1` constrains them. */
const HANDLE_PATTERN = /^[a-z0-9][a-z0-9-]{2,31}$/;

/** Hedera account id, the only form the facilitator accepts as a payer or payee. */
const ACCOUNT_ID_PATTERN = /^0\.0\.[0-9]+$/;

/** Ed25519 secret keys are 32 bytes of hex. */
const SIGNING_KEY_PATTERN = /^[0-9a-fA-F]{64}$/;

/** A whole, positive number of tinybars. */
const TINYBARS_PATTERN = /^[1-9][0-9]*$/;

/** The agent's protocol identity: who it signs as and who it is talking to. */
export type SigningIdentity = {
  /** Handle written into `mandate.issuer`. */
  handle: string;
  /** Envelope `from`. */
  agent: string;
  /** Envelope `to` — the contractor agent. */
  counterparty: string;
  /** Ed25519 secret key, hex. */
  privateKeyHex: string;
  /** Ed25519 public key, hex; also carried in every envelope signature. */
  publicKeyHex: string;
};

/** The agent's money identity: which account pays, on which network, up to how much. */
export type PaymentIdentity = {
  network: HederaNetwork;
  /** x402 asset id; `0.0.0` is HBAR. */
  asset: string;
  /** Hedera account the transfer debits. */
  accountId: string;
  /** ECDSA key of that account, as the account was created. */
  privateKeyHex: string;
  /** Per-payment ceiling in tinybars, enforced client-side before signing. */
  maxAmountPerPayment: string;
  /** Facilitator URL, recorded on receipts so a reader knows who settled. */
  facilitator: string;
};

/** Everything one CLI invocation needs. */
export type CustomerConfig = {
  signing: SigningIdentity;
  payment: PaymentIdentity;
  /** Default contractor base URL when `--to` is not given. */
  contractorUrl: string;
  /** Directory artifacts are written into. */
  outDir: string;
};

/** The environment does not describe a usable agent. */
export class ConfigError extends Error {
  /**
   * @param message - What is wrong and how to fix it
   */
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * Reads the agent's protocol identity.
 *
 * @param env - Environment to read, defaults to the process environment
 * @returns The signing identity
 * @throws ConfigError when a value is missing or malformed
 */
export function loadSigningIdentity(env: NodeJS.ProcessEnv = process.env): SigningIdentity {
  const handle = env["CUSTOMER_HANDLE"]?.trim() || "client-y-agent";
  assertHandle(handle, "CUSTOMER_HANDLE");
  const agent = env["CUSTOMER_AGENT"]?.trim() || handle;
  const counterparty = env["CONTRACTOR_AGENT"]?.trim() || "agency-x-agent";
  assertHandle(counterparty, "CONTRACTOR_AGENT");

  const privateKeyHex = (env["CUSTOMER_SIGNING_KEY"] ?? env["CUSTOMER_ED25519_PRIVATE_KEY"])?.trim();
  if (!privateKeyHex) {
    throw new ConfigError(
      "Missing CUSTOMER_SIGNING_KEY in .env — the Ed25519 key the agent signs work orders with. " +
        "Generate one with `openssl rand -hex 32`.",
    );
  }
  if (!SIGNING_KEY_PATTERN.test(privateKeyHex)) {
    throw new ConfigError("CUSTOMER_SIGNING_KEY must be 32 bytes of hex (64 characters)");
  }

  return {
    handle,
    agent,
    counterparty,
    privateKeyHex,
    publicKeyHex: publicKeyHex(privateKeyHex),
  };
}

/**
 * Reads the agent's money identity.
 *
 * Falls back to the `PAYER_*` account created for the payment spike, so a
 * machine that can already pay does not need a second account to run the demo.
 *
 * @param env - Environment to read, defaults to the process environment
 * @returns The payment identity
 * @throws ConfigError when a value is missing or malformed
 */
export function loadPaymentIdentity(env: NodeJS.ProcessEnv = process.env): PaymentIdentity {
  const accountId = (env["CUSTOMER_ACCOUNT_ID"] ?? env["PAYER_ACCOUNT_ID"])?.trim();
  if (!accountId) {
    throw new ConfigError("Missing CUSTOMER_ACCOUNT_ID (or PAYER_ACCOUNT_ID) in .env");
  }
  if (!ACCOUNT_ID_PATTERN.test(accountId)) {
    throw new ConfigError(`CUSTOMER_ACCOUNT_ID must be a Hedera account id like 0.0.1234, got "${accountId}"`);
  }

  const privateKeyHex = (env["CUSTOMER_PRIVATE_KEY"] ?? env["PAYER_PRIVATE_KEY"])?.trim();
  if (!privateKeyHex) {
    throw new ConfigError("Missing CUSTOMER_PRIVATE_KEY (or PAYER_PRIVATE_KEY) in .env");
  }

  const maxAmountPerPayment = env["CUSTOMER_MAX_TINYBARS_PER_PAYMENT"]?.trim() || DEFAULT_MAX_AMOUNT_PER_PAYMENT;
  if (!TINYBARS_PATTERN.test(maxAmountPerPayment)) {
    throw new ConfigError(
      `CUSTOMER_MAX_TINYBARS_PER_PAYMENT must be a whole positive number of tinybars, got "${maxAmountPerPayment}"`,
    );
  }

  return {
    network: readNetwork(env),
    asset: HBAR_ASSET,
    accountId,
    privateKeyHex,
    maxAmountPerPayment,
    facilitator: env["X402_FACILITATOR_URL"]?.trim() || DEFAULT_FACILITATOR_URL,
  };
}

/**
 * Reads both identities plus the CLI defaults.
 *
 * @param env - Environment to read, defaults to the process environment
 * @returns The configuration
 * @throws ConfigError when a value is missing or malformed
 */
export function loadCustomerConfig(env: NodeJS.ProcessEnv = process.env): CustomerConfig {
  return {
    signing: loadSigningIdentity(env),
    payment: loadPaymentIdentity(env),
    contractorUrl: env["CONTRACTOR_URL"]?.trim() || DEFAULT_CONTRACTOR_URL,
    outDir: env["CUSTOMER_OUT_DIR"]?.trim() || DEFAULT_OUT_DIR,
  };
}

/**
 * Resolves the network from either the short name used in `.env` or the CAIP-2 form.
 *
 * @param env - Environment to read
 * @returns The CAIP-2 network
 * @throws ConfigError for any other value
 */
function readNetwork(env: NodeJS.ProcessEnv): HederaNetwork {
  const raw = env["HEDERA_NETWORK"]?.trim().toLowerCase() || "testnet";
  if (raw === "testnet" || raw === "hedera:testnet") return "hedera:testnet";
  if (raw === "mainnet" || raw === "hedera:mainnet") return "hedera:mainnet";
  throw new ConfigError(`HEDERA_NETWORK must be testnet or mainnet, got "${raw}"`);
}

/**
 * Rejects a handle the protocol schemas would reject later, when the order is
 * already built and a counterparty is waiting.
 *
 * @param value - Candidate handle
 * @param name - Variable it came from, for the message
 * @throws ConfigError when the handle does not match the schema pattern
 */
function assertHandle(value: string, name: string): void {
  if (!HANDLE_PATTERN.test(value)) {
    throw new ConfigError(
      `${name} must be a handle of 3 to 32 lowercase letters, digits or dashes, got "${value}"`,
    );
  }
}

/**
 * Creates the two ECDSA testnet accounts the x402 spike needs and appends their
 * credentials to `.env` (gitignored):
 *
 *   PAYER    — the agent that pays for the HTTP resource (funded with 30 HBAR)
 *   RECEIVER — the `payTo` account of the paid route (funded with 1 HBAR)
 *
 * The x402 `exact` scheme on Hedera requires the payer key to be ECDSA, and the
 * facilitator rejects an alias as `payTo`, so both accounts are created as real
 * `0.0.x` accounts with `setKeyWithoutAlias`.
 *
 * Re-running is safe: accounts already present in `.env` are left alone.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { config as loadEnv } from "dotenv";
import {
  AccountCreateTransaction,
  AccountId,
  Client,
  Hbar,
  PrivateKey,
} from "@hiero-ledger/sdk";

loadEnv();

const ENV_PATH = new URL("../.env", import.meta.url).pathname;

const OPERATOR_ID = requireEnv("HEDERA_OPERATOR_ID");
const OPERATOR_KEY = requireEnv("HEDERA_OPERATOR_KEY");

/** Accounts to create, with the initial balance each one needs. */
const ACCOUNTS = [
  { role: "PAYER", initialBalanceHbar: 30 },
  { role: "RECEIVER", initialBalanceHbar: 1 },
] as const;

/**
 * Reads a required environment variable.
 *
 * @param name - Variable name
 * @returns The value
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name} in .env`);
  }
  return value;
}

/**
 * Builds a testnet client operated by the account in `.env`.
 *
 * @returns Configured Hedera client
 */
function operatorClient(): Client {
  const keyType = (process.env.HEDERA_OPERATOR_KEY_TYPE ?? "ecdsa").trim().toLowerCase();
  const key = keyType.startsWith("ed25519")
    ? PrivateKey.fromStringED25519(OPERATOR_KEY)
    : PrivateKey.fromStringECDSA(OPERATOR_KEY);
  return Client.forTestnet().setOperator(AccountId.fromString(OPERATOR_ID), key);
}

/**
 * Creates one ECDSA account and funds it from the operator.
 *
 * @param client - Operator-backed client
 * @param initialBalanceHbar - Initial balance in HBAR
 * @returns The new account id and its private key
 */
async function createEcdsaAccount(
  client: Client,
  initialBalanceHbar: number,
): Promise<{ accountId: string; privateKey: string }> {
  const privateKey = PrivateKey.generateECDSA();
  const receipt = await new AccountCreateTransaction()
    .setKeyWithoutAlias(privateKey.publicKey)
    .setInitialBalance(new Hbar(initialBalanceHbar))
    .execute(client)
    .then(response => response.getReceipt(client));

  const accountId = receipt.accountId;
  if (!accountId) {
    throw new Error("AccountCreateTransaction receipt carried no accountId");
  }
  return { accountId: accountId.toString(), privateKey: privateKey.toStringRaw() };
}

/**
 * Entry point: creates any missing spike account and records it in `.env`.
 */
async function main(): Promise<void> {
  const client = operatorClient();
  try {
    for (const { role, initialBalanceHbar } of ACCOUNTS) {
      const existing = process.env[`${role}_ACCOUNT_ID`];
      if (existing) {
        console.log(`${role}: ${existing} (already in .env, not recreated)`);
        continue;
      }

      const { accountId, privateKey } = await createEcdsaAccount(client, initialBalanceHbar);
      const block = [
        "",
        `# ${role} — ECDSA account created for the x402 spike`,
        `${role}_ACCOUNT_ID=${accountId}`,
        `${role}_PRIVATE_KEY=${privateKey}`,
        "",
      ].join("\n");

      appendFileSync(ENV_PATH, block, { encoding: "utf8", mode: 0o600 });
      process.env[`${role}_ACCOUNT_ID`] = accountId;

      console.log(`${role}: ${accountId} funded with ${initialBalanceHbar} HBAR (key written to .env)`);
    }
  } finally {
    client.close();
  }

  // Read back from disk so the run proves what a later process will actually load.
  const envText = readFileSync(ENV_PATH, "utf8");
  for (const role of ["PAYER", "RECEIVER"]) {
    const match = envText.match(new RegExp(`^${role}_ACCOUNT_ID=(.+)$`, "m"));
    console.log(`.env has ${role}_ACCOUNT_ID=${match?.[1] ?? "MISSING"}`);
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});

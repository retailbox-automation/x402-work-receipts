/**
 * Paying agent for the spike.
 *
 * Calls `GET /quote`, gets a 402 with Hedera payment requirements, builds and
 * partially signs a TransferTransaction with the PAYER key, retries with the
 * `PAYMENT-SIGNATURE` header, then reads the settlement out of the response and
 * confirms it independently against the public mirror node.
 *
 * Run (server must already be up): npm run spike:client
 */
import { config as loadEnv } from "dotenv";
import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { createClientHederaSigner, PrivateKey } from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import type { SettleResponse } from "@x402/core/types";

loadEnv();

const NETWORK = "hedera:testnet";
const HBAR_ASSET = "0.0.0";
const MIRROR_NODE = "https://testnet.mirrornode.hedera.com";
const EXPECTED_FEE_PAYER = "0.0.7162784";

const RESOURCE_URL = process.env.SPIKE_RESOURCE_URL ?? "http://localhost:4021/quote";
const PAYER_ACCOUNT_ID = requireEnv("PAYER_ACCOUNT_ID");
const PAYER_PRIVATE_KEY = requireEnv("PAYER_PRIVATE_KEY");
const RECEIVER_ACCOUNT_ID = requireEnv("RECEIVER_ACCOUNT_ID");

/** Mirror node shape for the fields this script reads. */
type MirrorTransaction = {
  transaction_id: string;
  result: string;
  consensus_timestamp: string;
  charged_tx_fee: number;
  transfers: { account: string; amount: number }[];
};

/**
 * Reads a required environment variable.
 *
 * @param name - Variable name
 * @returns The value
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name} in .env — run \`npm run spike:accounts\` first`);
  }
  return value;
}

/**
 * Converts an x402 settlement transaction id (`0.0.x@sec.nanos`) into the
 * hyphenated form the mirror node REST API expects (`0.0.x-sec-nanos`).
 *
 * @param transactionId - Transaction id as returned by the facilitator
 * @returns Mirror-node-formatted transaction id
 */
function toMirrorTransactionId(transactionId: string): string {
  return transactionId.replace("@", "-").replace(/\.(\d+)$/, "-$1");
}

/**
 * Polls the mirror node until the transaction is indexed.
 *
 * The mirror node lags consensus by a few seconds, so a settled transaction is
 * briefly a 404 there.
 *
 * @param transactionId - Transaction id as returned by the facilitator
 * @param attempts - How many times to poll
 * @param delayMs - Delay between polls
 * @returns The indexed transaction, or null if it never appeared
 */
async function fetchSettledTransaction(
  transactionId: string,
  attempts = 15,
  delayMs = 2000,
): Promise<MirrorTransaction | null> {
  // The mirror node both addresses and reports transactions in the hyphenated
  // form `0.0.x-sec-nanos`, not the `0.0.x@sec.nanos` form the facilitator returns.
  const mirrorId = toMirrorTransactionId(transactionId);
  const url = `${MIRROR_NODE}/api/v1/transactions/${mirrorId}`;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const response = await fetch(url);
    if (response.ok) {
      const body = (await response.json()) as { transactions?: MirrorTransaction[] };
      const transaction = body.transactions?.find(entry => entry.transaction_id === mirrorId);
      if (transaction) {
        return transaction;
      }
    }
    if (attempt < attempts) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  return null;
}

/**
 * Prints the on-chain transfer list and checks it against what we paid for.
 *
 * @param transaction - Mirror node transaction record
 */
function reportTransfers(transaction: MirrorTransaction): void {
  console.log(`\nmirror node result:        ${transaction.result}`);
  console.log(`consensus timestamp:       ${transaction.consensus_timestamp}`);
  console.log(`charged fee (tinybars):    ${transaction.charged_tx_fee}`);
  console.log("hbar transfers:");
  for (const transfer of transaction.transfers) {
    console.log(`  ${transfer.account.padEnd(14)} ${transfer.amount > 0 ? "+" : ""}${transfer.amount}`);
  }

  const netFor = (account: string) =>
    transaction.transfers
      .filter(transfer => transfer.account === account)
      .reduce((sum, transfer) => sum + transfer.amount, 0);

  const payerNet = netFor(PAYER_ACCOUNT_ID);
  const receiverNet = netFor(RECEIVER_ACCOUNT_ID);
  const feePayerNet = netFor(EXPECTED_FEE_PAYER);

  console.log("\nchecks:");
  console.log(`  payer ${PAYER_ACCOUNT_ID} debited 1000000 tinybars: ${payerNet === -1_000_000}`);
  console.log(`  receiver ${RECEIVER_ACCOUNT_ID} credited 1000000 tinybars: ${receiverNet === 1_000_000}`);
  console.log(`  facilitator ${EXPECTED_FEE_PAYER} paid the network fee: ${feePayerNet < 0}`);
}

/**
 * Entry point: pays for the resource and verifies settlement.
 */
async function main(): Promise<void> {
  const signer = createClientHederaSigner(
    PAYER_ACCOUNT_ID,
    PrivateKey.fromStringECDSA(PAYER_PRIVATE_KEY),
    { network: NETWORK },
  );

  const client = new x402Client().register("hedera:*", new ExactHederaScheme(signer));

  // Default spend controls only allow assets the scheme knows as defaults; on
  // Hedera that is USDC only, so native HBAR has to be opted in explicitly or
  // every payment is rejected client-side before it is ever signed.
  client.setSpendControls({
    allowedAssets: [{ network: NETWORK, asset: HBAR_ASSET, maxAmountPerPayment: "5000000" }],
  });

  const httpClient = new x402HTTPClient(client);
  const fetchWithPayment = wrapFetchWithPayment(fetch, httpClient);

  console.log(`payer:     ${PAYER_ACCOUNT_ID}`);
  console.log(`receiver:  ${RECEIVER_ACCOUNT_ID}`);
  console.log(`resource:  ${RESOURCE_URL}`);
  console.log("\npaying…");

  const response = await fetchWithPayment(RESOURCE_URL, { method: "GET" });
  const parsed = await httpClient.processResponse(response);

  console.log(`\nHTTP ${parsed.status}, payment status: ${parsed.paymentStatus}`);
  console.log(`resource body: ${JSON.stringify(parsed.body)}`);

  if (parsed.paymentStatus !== "settled") {
    console.error("\nsettlement did not succeed. Decoded x402 header:");
    console.error(JSON.stringify(parsed.header, null, 2));
    process.exit(1);
  }

  const settlement = parsed.header as SettleResponse;
  const transactionId = settlement.transaction;
  const hashscanUrl = `https://hashscan.io/testnet/transaction/${transactionId}`;

  console.log(`\nsettled by:  ${settlement.payer}`);
  console.log(`transaction: ${transactionId}`);
  console.log(`hashscan:    ${hashscanUrl}`);

  console.log("\nconfirming on the mirror node…");
  const onChain = await fetchSettledTransaction(transactionId);
  if (!onChain) {
    console.error("transaction not found on the mirror node yet — check the HashScan link manually");
    process.exit(1);
  }
  reportTransfers(onChain);

  console.log(`\nHASHSCAN: ${hashscanUrl}`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});

/**
 * x402-gated resource server for the spike.
 *
 * One route, `GET /quote`, priced at 1 000 000 tinybars (0.01 HBAR) on
 * `hedera:testnet`. Settlement runs through the Blocky402 testnet facilitator:
 * the middleware calls `POST /verify` before serving the response and
 * `POST /settle` after, and the facilitator pays the Hedera transaction fee
 * from its own account.
 *
 * `payTo` is the RECEIVER account created by `spike/create-accounts.ts` — the
 * facilitator rejects aliases, so it must be a real `0.0.x` account.
 *
 * Run: npm run spike:server
 */
import express from "express";
import { config as loadEnv } from "dotenv";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactHederaScheme } from "@x402/hedera/exact/server";

loadEnv();

const PORT = Number(process.env.SPIKE_PORT ?? 4021);
const NETWORK = "hedera:testnet";
/** HBAR is asset `0.0.0` in x402; amounts are in tinybars. */
const HBAR_ASSET = "0.0.0";
/** 1 000 000 tinybars = 0.01 HBAR. */
const PRICE_TINYBARS = "1000000";

const FACILITATOR_URL = process.env.X402_FACILITATOR_URL ?? "https://api.testnet.blocky402.com";
const PAY_TO = requireEnv("RECEIVER_ACCOUNT_ID");

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

const facilitatorClient = new HTTPFacilitatorClient({ url: FACILITATOR_URL });

// The Hedera server scheme copies `extra.feePayer` out of the facilitator's
// /supported response into the payment requirements, so nothing is hardcoded here.
const resourceServer = new x402ResourceServer(facilitatorClient).register(
  NETWORK,
  new ExactHederaScheme(),
);

const app = express();

app.use(
  paymentMiddleware(
    {
      "GET /quote": {
        accepts: {
          scheme: "exact",
          network: NETWORK,
          payTo: PAY_TO,
          price: { asset: HBAR_ASSET, amount: PRICE_TINYBARS },
          maxTimeoutSeconds: 120,
        },
        description: "A priced quote for one unit of work",
        mimeType: "application/json",
      },
    },
    resourceServer,
  ),
);

app.get("/quote", (_req, res) => {
  res.json({
    quote: {
      task: "translate-one-page",
      currency: "HBAR",
      amount: "12.50",
      validForSeconds: 900,
    },
    servedAt: new Date().toISOString(),
  });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, network: NETWORK, payTo: PAY_TO, facilitator: FACILITATOR_URL });
});

app.listen(PORT, () => {
  console.log(`x402 spike server on http://localhost:${PORT}`);
  console.log(`  GET /quote  price=${PRICE_TINYBARS} tinybars asset=${HBAR_ASSET} network=${NETWORK}`);
  console.log(`  payTo       ${PAY_TO}`);
  console.log(`  facilitator ${FACILITATOR_URL}`);
});

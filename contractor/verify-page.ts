/**
 * The verifier, for someone who has installed nothing.
 *
 * The command in `verifier/` is the real thing: a stranger clones the
 * repository and reaches a verdict with no help from either party. That is
 * also its whole problem as a demonstration — a judge with five minutes will
 * not clone anything, and an unread verifier proves as little as none.
 *
 * So this page is the same verification with the terminal removed: the form
 * posts documents to `POST /verify`, which runs `verifyDocuments` against the
 * public mirror node and nothing else. Two things it deliberately is not.
 * It is not a second implementation — every verdict on screen came from the
 * same checks the command runs, and the page cannot reach a verdict of its own.
 * And it is not evidence: the links beside each result point at the mirror node
 * and HashScan, so the answer to "why should I believe this page" is never the
 * page itself.
 *
 * The markup is one string with inline CSS and one inline script. No framework,
 * no external asset, no font, no build step — a page that fetched anything from
 * a third party to display a trust verdict would be arguing against itself.
 */
import { readFileSync } from "node:fs";
import type { Envelope, Mandate, PaymentReceipt } from "../protocol/types.js";

/** Where the bundled run lives, relative to this file. */
const DEMO_DIR = "../demo/fixtures/hosted-run-2026-09-12/";

/**
 * The topic the bundled run was actually anchored to.
 *
 * Not `config.topicId`: the demo has to be checked against the topic that
 * carries its anchors, whatever topic this instance happens to be configured
 * for. A demo that verified only because it was pointed at a convenient topic
 * would be a decoration.
 */
export const DEMO_TOPIC_ID = "0.0.10426298";

/** The bundled work order and receipt, with the topic they belong to. */
export type DemoRun = {
  receipt: Envelope<PaymentReceipt>;
  mandate: Envelope<Mandate>;
  topicId: string;
};

/** Read once per process; the bundled files do not change under a running server. */
let cachedDemo: DemoRun | undefined;

/**
 * The bundled demo run.
 *
 * @returns The two envelopes and the topic they were anchored to
 * @throws When the bundled fixture is missing from the deployment
 */
export function demoRun(): DemoRun {
  if (cachedDemo === undefined) {
    cachedDemo = {
      receipt: readFixture<Envelope<PaymentReceipt>>("receipt.json"),
      mandate: readFixture<Envelope<Mandate>>("mandate.json"),
      topicId: DEMO_TOPIC_ID,
    };
  }
  return cachedDemo;
}

/**
 * Reads one bundled fixture.
 *
 * @param name - File name inside {@link DEMO_DIR}
 * @returns The parsed envelope
 */
function readFixture<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(`${DEMO_DIR}${name}`, import.meta.url), "utf8")) as T;
}

/**
 * The page.
 *
 * @param topicId - Topic to prefill the form with, i.e. this instance's own
 * @returns A complete HTML document
 */
export function verifyPageHtml(topicId: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Verify a receipt — x402 Work Receipts</title>
<style>
  :root{color-scheme:dark}
  body{background:#0b0d10;color:#e6e6e6;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:860px;margin:2.5rem auto;padding:0 1.25rem}
  h1{font-size:1.4rem;margin-bottom:.25rem}
  h2{font-size:1.05rem;margin:1.75rem 0 .5rem}
  p{color:#b7bdc6}
  a{color:#7fd0ff}
  label{display:block;margin:.9rem 0 .25rem;font-size:.85rem;color:#9aa3ad;text-transform:uppercase;letter-spacing:.04em}
  textarea,input{width:100%;box-sizing:border-box;background:#12151a;color:#e6e6e6;border:1px solid #262b33;border-radius:6px;padding:.6rem .7rem;font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}
  textarea{height:8.5rem;resize:vertical}
  .row{display:flex;gap:.6rem;flex-wrap:wrap;margin-top:1rem;align-items:center}
  button{background:#1f6feb;color:#fff;border:0;border-radius:6px;padding:.6rem 1.1rem;font-size:.95rem;cursor:pointer}
  button.ghost{background:#1b1f26;color:#cfd6de;border:1px solid #2b313a}
  button:disabled{opacity:.55;cursor:progress}
  #status{color:#9aa3ad;font-size:.9rem;min-height:1.4rem;margin-top:.6rem}
  table{border-collapse:collapse;width:100%;font-size:.9rem;margin-top:.5rem}
  th,td{border-bottom:1px solid #22262d;padding:.45rem .5rem;text-align:left;vertical-align:top}
  th{color:#9aa3ad;font-weight:600;font-size:.78rem;text-transform:uppercase;letter-spacing:.04em}
  td.v{font-weight:700;white-space:nowrap}
  .pass{color:#3fb950}.fail{color:#f85149}.na{color:#8b949e}
  .verdict{margin-top:1rem;padding:.75rem 1rem;border-radius:6px;border:1px solid #262b33;background:#12151a;font-weight:700}
  .verdict.ok{border-color:#245c32;color:#3fb950}
  .verdict.no{border-color:#6e2b28;color:#f85149}
  .statement{font-size:.88rem;color:#9aa3ad;border-left:2px solid #2b313a;padding-left:.9rem;margin-top:1rem}
  code,pre{background:#181b20;border-radius:4px;font-size:.85em}
  code{padding:.15rem .35rem}
  pre{padding:.7rem .9rem;overflow-x:auto;color:#cfd6de}
  ul{padding-left:1.1rem;font-size:.9rem}
  li{margin:.2rem 0}
  .note{font-size:.85rem;color:#6b7280}
  footer{margin-top:2.5rem;color:#6b7280;font-size:.85rem}
  [hidden]{display:none!important}
</style>
</head>
<body>
<h1>Verify a receipt</h1>
<p>Paste a <code>receipt.v1+payment.v1</code> receipt from this protocol — or load the bundled run — and
this page reaches the same verdict the command-line verifier prints, from the public Hedera mirror node
alone. It calls neither the contractor that issued the receipt nor the customer that paid for it.</p>
<p class="note">The server only reads the public mirror node; your documents are not stored.</p>

<label for="receipt">receipt.json</label>
<textarea id="receipt" spellcheck="false" placeholder="Paste the signed delivery receipt"></textarea>
<label for="mandate">mandate.json (optional — lets the fingerprint be recomputed from the work order)</label>
<textarea id="mandate" spellcheck="false" placeholder="Paste the signed work order, or leave empty"></textarea>
<label for="topic">topic id</label>
<input id="topic" spellcheck="false" value="${topicId}">

<div class="row">
  <button id="verify">Verify</button>
  <button id="demo" class="ghost">Load the demo run</button>
</div>
<div id="status"></div>

<section id="results" hidden>
  <h2>Checks</h2>
  <table><thead><tr><th>check</th><th>verdict</th><th>detail</th></tr></thead><tbody id="rows"></tbody></table>
  <div id="verdict" class="verdict"></div>
  <p class="statement" id="statement"></p>
  <h2>See it for yourself</h2>
  <ul id="links"></ul>
  <h2>Or check it offline</h2>
  <p class="note">Same checks, same verdict, no server in the middle:</p>
  <pre><code id="cli"></code></pre>
</section>

<footer>Hedera testnet only &middot; <a href="/">Home</a> &middot;
<a href="https://github.com/retailbox-automation/x402-work-receipts">Source</a></footer>

<script>
(function(){
  var byId = function(id){ return document.getElementById(id); };
  var say = function(text){ byId("status").textContent = text; };
  var busy = function(on){ byId("verify").disabled = on; byId("demo").disabled = on; };

  // Built with textContent and element properties rather than innerHTML: the
  // details come from documents a stranger pasted, and a verifier that let
  // them run script would be the least trustworthy page on the internet.
  var cell = function(text, className){
    var td = document.createElement("td");
    td.textContent = text;
    if (className) { td.className = className; }
    return td;
  };

  var link = function(label, href){
    var li = document.createElement("li");
    var a = document.createElement("a");
    a.href = href;
    a.textContent = label;
    a.rel = "noreferrer";
    li.appendChild(a);
    return li;
  };

  var render = function(answer){
    var rows = byId("rows");
    rows.textContent = "";
    (answer.results || []).forEach(function(result){
      var verdict = result.applicable === false ? "N/A" : (result.ok ? "PASS" : "FAIL");
      var tone = verdict === "PASS" ? "pass" : (verdict === "FAIL" ? "fail" : "na");
      var tr = document.createElement("tr");
      tr.appendChild(cell(result.name));
      tr.appendChild(cell(verdict, "v " + tone));
      tr.appendChild(cell(result.detail || ""));
      rows.appendChild(tr);
    });

    var verdict = byId("verdict");
    verdict.textContent = answer.summary || "";
    verdict.className = "verdict " + (answer.ok ? "ok" : "no");
    byId("statement").textContent = answer.statement || "";
    byId("cli").textContent = answer.cli || "";

    var list = byId("links");
    list.textContent = "";
    var links = answer.links || {};
    if (links.topic) {
      list.appendChild(link("Audit topic " + links.topic.id + " on HashScan", links.topic.url));
    }
    (links.transactions || []).forEach(function(transaction){
      list.appendChild(link("Payment " + transaction.id + " on HashScan", transaction.url));
    });
    (links.anchors || []).forEach(function(anchor){
      list.appendChild(link("Anchor #" + anchor.seq + " (" + anchor.kind + ") on the mirror node", anchor.url));
    });

    byId("results").hidden = false;
    say("Exit code " + answer.exitCode + " — the command-line verifier prints the same.");
  };

  var parse = function(id, what){
    var text = byId(id).value.trim();
    if (!text) { return null; }
    try { return JSON.parse(text); }
    catch (error) { throw new Error("The " + what + " box is not valid JSON: " + error.message); }
  };

  byId("demo").addEventListener("click", function(){
    busy(true);
    say("Loading the bundled run…");
    fetch("/verify/demo").then(function(response){
      if (!response.ok) { throw new Error("HTTP " + response.status); }
      return response.json();
    }).then(function(run){
      byId("receipt").value = JSON.stringify(run.receipt, null, 2);
      byId("mandate").value = JSON.stringify(run.mandate, null, 2);
      byId("topic").value = run.topicId;
      byId("results").hidden = true;
      say("Demo run loaded. Press Verify — it reads the live mirror node.");
    }).catch(function(error){
      say("Could not load the demo run: " + error.message);
    }).then(function(){ busy(false); });
  });

  byId("verify").addEventListener("click", function(){
    var body;
    try {
      var receipt = parse("receipt", "receipt");
      if (!receipt) { say("Paste a receipt, or load the demo run."); return; }
      body = { topicId: byId("topic").value.trim(), receipt: receipt };
      var mandate = parse("mandate", "work-order");
      if (mandate) { body.mandate = mandate; }
    } catch (error) { say(error.message); return; }

    busy(true);
    say("Reading the public mirror node…");
    fetch("/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }).then(function(response){
      return response.json().catch(function(){ return { error: "HTTP " + response.status }; })
        .then(function(answer){ return { status: response.status, answer: answer }; });
    }).then(function(result){
      // A failed verdict arrives as 200: the verification succeeded, its answer
      // was no. Only 4xx and 5xx mean the page has nothing to show.
      if (result.status === 200) { render(result.answer); return; }
      byId("results").hidden = true;
      say(result.answer.error || ("The server answered " + result.status + "."));
    }).catch(function(error){
      say("Could not reach the server: " + error.message);
    }).then(function(){ busy(false); });
  });
})();
</script>
</body>
</html>
`;
}

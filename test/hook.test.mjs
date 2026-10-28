// Unit tests with a mocked OceanAlt (no network), plus an integration test against the real @x402/core x402Client
// with a fake scheme: proves that on decline / review / outage the scheme is never asked to sign.
import { test } from "node:test";
import assert from "node:assert/strict";
import { oceanaltBeforePaymentHook, decideBody, paymentFromContext, normalise } from "../hook.mjs";

const PAYEE = "0x1111111111111111111111111111111111111111";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const paymentRequired = (over = {}) => ({
  x402Version: 2,
  resource: { url: "https://api.example.com/data", description: "data", mimeType: "application/json" },
  accepts: [{ scheme: "exact", network: "eip155:8453", amount: "10000", asset: USDC_BASE, payTo: PAYEE, maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" }, ...over }],
});
const ctx = (over) => { const pr = paymentRequired(over); return { paymentRequired: pr, selectedRequirements: pr.accepts[0] }; };

function mockFetch(answer, { status = 200, throws } = {}) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    if (throws) throw throws;
    return new Response(typeof answer === "string" ? answer : JSON.stringify(answer), { status, headers: { "content-type": "application/json" } });
  };
  f.calls = calls;
  return f;
}

test("allow -> hook returns nothing (payment proceeds)", async () => {
  const f = mockFetch({ decision: "allow", allow: true, verdict: "clear", address: PAYEE, reason_code: "ok", receipt: { sig: "x" } });
  let seen;
  const hook = oceanaltBeforePaymentHook({ fetch: f, onDecision: (r) => { seen = r; } });
  assert.equal(await hook(ctx()), undefined);
  assert.equal(seen.decision, "allow");
  assert.deepEqual(seen.receipt, { sig: "x" });
  assert.equal(f.calls[0].url, "https://oceanalt.com/api/decide");
});

test("request body carries payee, network, USD amount and a Payment Intent v1 with the 402 URL", async () => {
  const f = mockFetch({ decision: "allow", allow: true, verdict: "clear", address: PAYEE });
  await oceanaltBeforePaymentHook({ fetch: f })(ctx());
  const b = f.calls[0].body;
  assert.equal(b.to, PAYEE);
  assert.equal(b.network, "eip155:8453");
  assert.equal(b.amountUsdc, 0.01);
  assert.deepEqual(b.payment_intent, { v: "1", payee: PAYEE, amount_atomic: "10000", asset_id: `eip155:8453/erc20:${USDC_BASE}`, network: "eip155:8453", resource_ref: "https://api.example.com/data" });
  assert.equal(f.calls[0].init.headers["x-api-key"], undefined, "no key header unless configured");
});

test("decline -> abort with reason", async () => {
  const f = mockFetch({ decision: "decline", allow: false, verdict: "risky", address: PAYEE, reason_code: "sanctioned_or_high_risk_payee" });
  const r = await oceanaltBeforePaymentHook({ fetch: f })(ctx());
  assert.equal(r.abort, true);
  assert.match(r.reason, /decline: sanctioned_or_high_risk_payee/);
});

test("decline is not overridable by onReview", async () => {
  const f = mockFetch({ decision: "decline", allow: false, address: PAYEE });
  const r = await oceanaltBeforePaymentHook({ fetch: f, onReview: () => true })(ctx());
  assert.equal(r.abort, true);
});

test("review -> abort unless onReview returns exactly true", async () => {
  const f = mockFetch({ decision: "review", allow: false, address: PAYEE, reason_code: "payee_not_bound_to_origin" });
  assert.equal((await oceanaltBeforePaymentHook({ fetch: f })(ctx())).abort, true);
  assert.equal((await oceanaltBeforePaymentHook({ fetch: f, onReview: () => "yes" })(ctx())).abort, true);
  assert.equal((await oceanaltBeforePaymentHook({ fetch: f, onReview: () => { throw new Error("x"); } })(ctx())).abort, true);
  assert.equal(await oceanaltBeforePaymentHook({ fetch: f, onReview: async () => true })(ctx()), undefined);
});

test("fail closed: network error, timeout, HTTP 500, 429, non-JSON, uncertain, wrong address, missing payTo", async () => {
  const cases = [
    mockFetch(null, { throws: new TypeError("fetch failed") }),
    mockFetch(null, { throws: Object.assign(new Error("t"), { name: "TimeoutError" }) }),
    mockFetch({ error: "x" }, { status: 500 }),
    mockFetch({ error: "rate" }, { status: 429 }),
    mockFetch("<html>", {}),
    mockFetch({ decision: "allow", allow: true, verdict: "uncertain", address: PAYEE }),
    mockFetch({ decision: "allow", allow: true, verdict: "clear", address: "0x2222222222222222222222222222222222222222" }),
    mockFetch({ decision: "maybe" }),
  ];
  for (const f of cases) {
    const r = await oceanaltBeforePaymentHook({ fetch: f })(ctx());
    assert.equal(r?.abort, true, `expected abort for ${JSON.stringify(f.calls[0]?.body?.to)}`);
  }
  const noPayee = await oceanaltBeforePaymentHook({ fetch: mockFetch({ decision: "allow", allow: true }) })(ctx({ payTo: "" }));
  assert.equal(noPayee.abort, true);
});

test("timeout is real: a hanging OceanAlt aborts the payment after timeoutMs", async () => {
  const hang = (url, init) => new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(init.signal.reason)));
  const t0 = Date.now();
  const r = await oceanaltBeforePaymentHook({ fetch: hang, timeoutMs: 150 })(ctx());
  assert.equal(r.abort, true);
  assert.match(r.reason, /oceanalt.unavailable/);
  assert.ok(Date.now() - t0 < 2000);
});

test("apiKey is sent only as x-api-key to the configured OceanAlt base URL", async () => {
  const f = mockFetch({ decision: "allow", allow: true, verdict: "clear", address: PAYEE });
  await oceanaltBeforePaymentHook({ fetch: f, apiKey: "k", baseUrl: "https://oceanalt.com/" })(ctx());
  assert.equal(f.calls[0].url, "https://oceanalt.com/api/decide");
  assert.equal(f.calls[0].init.headers["x-api-key"], "k");
});

test("v1 requirement shape (maxAmountRequired, resource on the requirement, network name)", () => {
  const req = { scheme: "exact", network: "base", maxAmountRequired: "5000", asset: USDC_BASE, payTo: PAYEE, resource: "https://x.example/r", extra: { name: "USDC" } };
  const p = paymentFromContext({ paymentRequired: { x402Version: 1, accepts: [req] }, selectedRequirements: req });
  assert.equal(p.amount, "5000");
  assert.equal(p.resource, "https://x.example/r");
  const b = decideBody(p);
  assert.equal(b.network, "base");
  assert.equal(b.amountUsdc, 0.005);
  assert.equal(b.payment_intent, undefined, "no CAIP-2 network -> no Payment Intent");
});

test("non-USD asset -> no USD amount guessed; Solana gets a token asset id", () => {
  const p = { payee: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", amount: "100", asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", resource: "", assetName: "" };
  const b = decideBody(p);
  assert.equal(b.amountUsdc, undefined);
  assert.equal(b.payment_intent.asset_id, "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
});

test("normalise: explicit allow=false is not allow", () => {
  assert.equal(normalise({ decision: "allow", allow: false, address: PAYEE }, PAYEE).decision, "review");
});

// ---- Integration with the real @x402/core client ----
let x402Client = null;
try { ({ x402Client } = await import("@x402/core/client")); } catch { /* not installed */ }

test("integration: real x402Client never calls the scheme when OceanAlt declines, is down, or says review", { skip: !x402Client && "@x402/core not installed (npm install)" }, async () => {
  for (const f of [
    mockFetch({ decision: "decline", allow: false, address: PAYEE, reason_code: "sanctioned_or_high_risk_payee" }),
    mockFetch(null, { throws: new TypeError("fetch failed") }),
    mockFetch({ decision: "review", allow: false, address: PAYEE }),
  ]) {
    let signed = 0;
    const scheme = { scheme: "exact", createPaymentPayload: async () => { signed++; return { x402Version: 2, payload: { signature: "0xsig" } }; } };
    const client = new x402Client().setSpendControls(false).register("eip155:*", scheme).onBeforePaymentCreation(oceanaltBeforePaymentHook({ fetch: f }));
    await assert.rejects(client.createPaymentPayload(paymentRequired()), /Payment creation aborted: OceanAlt/);
    assert.equal(signed, 0, "scheme must not sign");
  }
});

test("integration: real x402Client signs when OceanAlt allows", { skip: !x402Client && "@x402/core not installed (npm install)" }, async () => {
  let signed = 0;
  const scheme = { scheme: "exact", createPaymentPayload: async () => { signed++; return { x402Version: 2, payload: { signature: "0xsig" } }; } };
  const f = mockFetch({ decision: "allow", allow: true, verdict: "clear", address: PAYEE });
  const client = new x402Client().setSpendControls(false).register("eip155:*", scheme).onBeforePaymentCreation(oceanaltBeforePaymentHook({ fetch: f }));
  const payload = await client.createPaymentPayload(paymentRequired());
  assert.equal(signed, 1);
  assert.equal(payload.accepted.payTo, PAYEE);
});

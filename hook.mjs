// OceanAlt pre-payment check as an x402 `onBeforePaymentCreation` hook (@x402/core v2 client).
//
//   import { x402Client } from "@x402/fetch";
//   import { oceanaltBeforePaymentHook } from "@oceanalt/x402/hook";
//   const client = new x402Client().register("eip155:*", scheme).onBeforePaymentCreation(oceanaltBeforePaymentHook());
//
// Before the payment payload is signed, the hook sends the payee (payTo), network, asset, amount and the URL that
// asked for payment to POST https://oceanalt.com/api/decide (free, no key) and maps the answer:
//   allow   -> returns nothing, the x402 client signs and pays
//   decline -> returns { abort: true, reason }, nothing is signed
//   review  -> aborts unless opts.onReview(result, context) returns exactly true
// Fail closed: a timeout, network error, HTTP error, malformed answer, `uncertain` verdict or an answer about a
// different address is treated as review, never allow.
//
// Zero dependencies (global fetch, Node 18+ / browsers / Deno / Bun). No keys, no custody. Nothing is sent except the
// fields listed above. Not affiliated with or endorsed by Coinbase or the x402 Foundation.

export const DEFAULT_BASE_URL = "https://oceanalt.com";
export const DEFAULT_TIMEOUT_MS = 8000;

const CAIP2 = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/;
const EVM_ADDR = /^0x[0-9a-fA-F]{40}$/;
const ATOMIC = /^(0|[1-9][0-9]*)$/;

/** Pull the payment the x402 client is about to sign out of the hook context. Works for v1 and v2 requirement shapes. */
export function paymentFromContext(context) {
  const req = context?.selectedRequirements || {};
  const pr = context?.paymentRequired || {};
  const payee = typeof req.payTo === "string" ? req.payTo.trim() : "";
  const network = typeof req.network === "string" ? req.network.trim() : "";
  const amount = String(req.amount ?? req.maxAmountRequired ?? "").trim();
  const asset = typeof req.asset === "string" ? req.asset.trim() : "";
  const resource = (typeof pr.resource === "object" && pr.resource?.url) || (typeof req.resource === "string" ? req.resource : "") || "";
  return { payee, network, amount, asset, resource, assetName: req.extra?.name };
}

/** Request body for /api/decide. Adds a Payment Intent v1 when the requirement is complete enough to build one. */
export function decideBody(p, { purpose = "x402 payment" } = {}) {
  const body = { to: p.payee, purpose };
  if (p.network) body.network = p.network;
  // USDC-style assets (EIP-712 domain name "USD Coin" / "USDC") have 6 decimals; only then is a USD amount sent.
  if (ATOMIC.test(p.amount) && /^usd/i.test(String(p.assetName || ""))) body.amountUsdc = Number(p.amount) / 1e6;
  if (CAIP2.test(p.network) && ATOMIC.test(p.amount) && p.asset) {
    const ns = p.network.split(":")[0];
    const assetId = ns === "eip155" && EVM_ADDR.test(p.asset) ? `${p.network}/erc20:${p.asset}` : ns === "solana" ? `${p.network}/token:${p.asset}` : "";
    if (assetId && (ns !== "eip155" || EVM_ADDR.test(p.payee))) {
      body.payment_intent = { v: "1", payee: p.payee, amount_atomic: p.amount, asset_id: assetId, network: p.network };
      if (/^https?:\/\//i.test(p.resource)) body.payment_intent.resource_ref = p.resource;
    }
  }
  return body;
}

const review = (reason_code, detail, extra = {}) => ({ decision: "review", allow: false, reason_code, detail, failClosed: true, ...extra });

/** Normalise an /api/decide answer for `payee`. Anything that is not a clean allow or an explicit decline is review. */
export function normalise(answer, payee) {
  if (!answer || typeof answer !== "object") return review("oceanalt.malformed", "OceanAlt returned no JSON object.");
  const echoed = typeof answer.address === "string" ? answer.address : "";
  if (echoed && echoed.toLowerCase() !== payee.toLowerCase()) {
    return review("oceanalt.address_mismatch", `OceanAlt answered about ${echoed}, not ${payee}.`);
  }
  const base = { reason_code: answer.reason_code ?? null, verdict: answer.verdict ?? null, signal_keys: answer.signal_keys ?? [], receipt: answer.receipt ?? null };
  if (answer.decision === "decline") return { decision: "decline", allow: false, ...base, detail: `OceanAlt declined ${payee}.` };
  if (answer.decision === "allow" && answer.allow !== false && answer.verdict !== "uncertain") return { decision: "allow", allow: true, ...base, detail: `OceanAlt allowed ${payee}.` };
  return { decision: "review", allow: false, ...base, reason_code: base.reason_code || `decide.${answer.decision ?? "unknown"}`, detail: `OceanAlt returned '${answer.decision}' for ${payee}; a human should confirm.`, failClosed: answer.decision !== "review" };
}

/** Ask OceanAlt about one payment. Never throws: errors come back as review with failClosed: true. */
export async function checkPayment(p, opts = {}) {
  if (!p.payee) return review("input.missing_payee", "The payment requirement has no payTo.");
  const baseUrl = (opts.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const f = opts.fetch || globalThis.fetch;
  const headers = { "content-type": "application/json", "user-agent": opts.userAgent || "oceanalt-x402-hook/0.1.0" };
  if (opts.apiKey) headers["x-api-key"] = opts.apiKey; // sent to baseUrl only
  let res;
  try {
    res = await f(`${baseUrl}/api/decide`, {
      method: "POST",
      headers,
      body: JSON.stringify(decideBody(p, opts)),
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (e) {
    return review("oceanalt.unavailable", `OceanAlt could not be reached (${e?.name === "TimeoutError" ? "timeout" : e?.message || e}). Not treated as safe.`);
  }
  if (!res.ok) return review("oceanalt.http_error", `OceanAlt returned HTTP ${res.status}. Not treated as safe.`);
  let json;
  try { json = await res.json(); } catch { return review("oceanalt.malformed", "OceanAlt returned a body that is not JSON."); }
  return normalise(json, p.payee);
}

/**
 * Build the hook. Options:
 *   baseUrl?, apiKey?, timeoutMs?, fetch?, purpose?, userAgent?
 *   onReview?(result, context) -> true to pay anyway (e.g. after a human approved). Anything else aborts.
 *   onDecision?(result, context) observer, e.g. to store result.receipt (Ed25519-signed, verifiable offline).
 */
export function oceanaltBeforePaymentHook(opts = {}) {
  if (opts.onReview != null && typeof opts.onReview !== "function") throw new TypeError("onReview must be a function");
  return async function oceanaltBeforePayment(context) {
    const p = paymentFromContext(context);
    const result = await checkPayment(p, opts);
    try { opts.onDecision?.(result, context); } catch { /* observer only */ }
    if (result.decision === "allow") return undefined;
    if (result.decision === "review" && typeof opts.onReview === "function") {
      let ok = false;
      try { ok = (await opts.onReview(result, context)) === true; } catch { ok = false; }
      if (ok) return undefined;
    }
    return { abort: true, reason: `OceanAlt ${result.decision}: ${result.reason_code || "no reason code"} (payee ${p.payee || "missing"})` };
  };
}

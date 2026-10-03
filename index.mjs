// @oceanalt/x402 — wrap fetch; intervene only when money is about to move.
//
// Flow on every request:
//   1. endpoint screening (cached per host)          → risky → block (or advise)
//   2. secret-exfiltration guard on the outgoing body → secret to a non-allowlisted host → block, anomaly recorded
//   3. send. If the reply is 402:
//      a. decode PAYMENT-REQUIRED (x402 v2 header; v1 body fallback)
//      b. verify extensions.signedRequirements offline (if present) → tampered → block
//      c. pre-settlement decision on the payee (accepts[0].payTo)    → decline → block; review → block in "block" mode
//      d. hand the (verified) requirements to YOUR payer (opts.pay) which returns the payment headers; retry once
//   4. record intent → decision → outcome (+ anomalies) via client.record(); nothing leaves the process unless you forward it.
import { ANOMALY, parsePaymentRequired } from "@oceanalt/core";

const DEFAULTS = { mode: "block", requireSignature: false, screenEndpoints: true, guardSecrets: true };

export function wrapFetch(baseFetch, opts) {
  const client = opts?.client;
  if (!client) throw new Error("@oceanalt/x402: opts.client (OceanAltClient) is required");
  const o = { ...DEFAULTS, ...opts };
  const hostCache = new Map(); // host → { verdict, at }

  async function screen(url) {
    let host = ""; try { host = new URL(url).host; } catch { return null; }
    const c = hostCache.get(host); if (c && Date.now() - c.at < 10 * 60_000) return c.verdict;
    let verdict = "unknown";
    try { verdict = (await client.endpoint(url)).verdict || "unknown"; } catch { verdict = "unavailable"; }
    hostCache.set(host, { verdict, at: Date.now() });
    return verdict;
  }
  const block = (rec, msg) => { const e = new Error(`[OceanAlt] ${msg}`); e.record = rec; throw e; };

  return async function guardedFetch(input, init = {}) {
    const url = typeof input === "string" ? input : input?.url || String(input);
    const anomalies = [];
    const rec = { kind: "x402.request", intent: { url, method: init.method || "GET" }, anomalies };

    if (o.screenEndpoints) {
      const v = await screen(url);
      rec.endpoint = v;
      if (v === "risky") { anomalies.push({ code: ANOMALY.RISKY_ENDPOINT, host: new URL(url).host }); rec.outcome = "blocked"; client.record(rec); if (o.mode === "block") block(rec, `endpoint ${new URL(url).host} screened as risky`); }
    }
    if (o.guardSecrets && init.body != null) {
      const text = typeof init.body === "string" ? init.body : (() => { try { return JSON.stringify(init.body); } catch { return ""; } })();
      const found = client.guardOutbound(url, text);
      if (found.length) { anomalies.push(...found); rec.outcome = "blocked"; client.record(rec); if (o.mode === "block") block(rec, `refusing to send ${found.map((f) => f.kind).join(", ")} to ${new URL(url).host}`); }
    }

    const res = await baseFetch(input, init);
    if (res.status !== 402) { rec.outcome = `http_${res.status}`; client.record(rec); return res; }

    // ── 402: decode requirements ──
    const header = res.headers.get("payment-required") || res.headers.get("PAYMENT-REQUIRED");
    let pr = header ? parsePaymentRequired(header) : null;
    if (!pr) { try { pr = await res.clone().json(); } catch { pr = null; } }
    if (!pr || !Array.isArray(pr.accepts) || !pr.accepts.length) { rec.outcome = "402_unparseable"; client.record(rec); return res; }
    const first = pr.accepts[0];
    rec.intent = { ...rec.intent, payTo: first.payTo, amount: first.amount ?? first.maxAmountRequired ?? first.price, network: first.network, asset: first.asset };

    // ── verify signature ──
    const v = await client.verifyRequirements(pr);
    rec.signature = v.reason_code;
    if (v.reason_code !== "ok" && v.reason_code !== "no_signature") { anomalies.push({ code: ANOMALY.TAMPERED_402, reason: v.reason_code }); rec.outcome = "blocked"; client.record(rec); block(rec, `payment requirements failed verification (${v.reason_code}): ${v.detail}`); }
    if (v.reason_code === "no_signature" && o.requireSignature) { rec.outcome = "blocked"; client.record(rec); block(rec, "seller does not sign payment requirements and requireSignature is on"); }

    // ── payee decision ──
    let decision = "review";
    try { decision = (await client.decide({ to: first.payTo, network: first.network })).decision || "review"; } catch { decision = "review"; }
    rec.decision = decision;
    if (decision === "decline") { anomalies.push({ code: ANOMALY.RISKY_PAYEE, payTo: first.payTo }); rec.outcome = "blocked"; client.record(rec); block(rec, `payee ${first.payTo} declined by pre-settlement decision`); }
    if (decision === "review" && o.mode === "block") { rec.outcome = "held"; client.record(rec); block(rec, `payee ${first.payTo} needs review before paying`); }

    // ── pay (your payer) and retry once ──
    if (typeof o.pay !== "function") { rec.outcome = "402_returned"; client.record(rec); return res; }
    let headers;
    try { headers = await o.pay(pr, { verified: v.verified, decision }); } catch (e) { rec.outcome = "pay_failed"; rec.error = String(e?.message || e); client.record(rec); throw e; }
    const retry = await baseFetch(input, { ...init, headers: { ...(init.headers || {}), ...(headers || {}) } });
    rec.outcome = retry.ok ? "paid" : `retry_http_${retry.status}`;
    client.record(rec);
    return retry;
  };
}

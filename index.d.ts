import type { OceanAltClient } from "@oceanalt/core";
export type WrapOptions = {
  client: OceanAltClient;
  /** "block" (default): throw on risky endpoint / tampered 402 / declined or review payee / secret exfil. "advise": record only. */
  mode?: "block" | "advise";
  /** Refuse 402s that carry no signedRequirements extension. Default false (most sellers do not sign yet). */
  requireSignature?: boolean;
  screenEndpoints?: boolean;
  guardSecrets?: boolean;
  /** Your payer: given the (verified) PaymentRequired, return the headers to retry with (e.g. { "PAYMENT-SIGNATURE": "..." }). We never hold keys. */
  pay?: (paymentRequired: unknown, ctx: { verified: boolean; decision: string }) => Promise<Record<string, string>>;
};
export declare function wrapFetch(baseFetch: typeof fetch, opts: WrapOptions): typeof fetch;

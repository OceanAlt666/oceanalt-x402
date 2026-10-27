export interface OceanAltCheckResult {
  decision: "allow" | "review" | "decline";
  allow: boolean;
  reason_code: string | null;
  detail: string;
  verdict?: string | null;
  signal_keys?: string[];
  /** Ed25519-signed copy of the decision; verify offline with https://oceanalt.com/.well-known/oceanalt-keys.json */
  receipt?: unknown;
  /** true when OceanAlt gave no usable answer and the hook treated that as review */
  failClosed?: boolean;
}

export interface OceanAltHookOptions {
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  purpose?: string;
  userAgent?: string;
  /** Return exactly true to pay anyway on review (e.g. a human approved). */
  onReview?: (result: OceanAltCheckResult, context: any) => boolean | Promise<boolean>;
  onDecision?: (result: OceanAltCheckResult, context: any) => void;
}

export interface PaymentSummary { payee: string; network: string; amount: string; asset: string; resource: string; assetName?: string }

export const DEFAULT_BASE_URL: string;
export const DEFAULT_TIMEOUT_MS: number;
export function paymentFromContext(context: any): PaymentSummary;
export function decideBody(p: PaymentSummary, opts?: { purpose?: string }): Record<string, unknown>;
export function normalise(answer: unknown, payee: string): OceanAltCheckResult;
export function checkPayment(p: PaymentSummary, opts?: OceanAltHookOptions): Promise<OceanAltCheckResult>;
/** Matches @x402/core BeforePaymentCreationHook: (ctx) => Promise<void | { abort: true; reason: string }> */
export function oceanaltBeforePaymentHook(opts?: OceanAltHookOptions): (context: any) => Promise<void | { abort: true; reason: string }>;

# @oceanalt/x402

## Hook for the x402 client (`@oceanalt/x402/hook`, new in 0.3.0)

One line in an existing `@x402/core` client. Before the payment is signed, the hook sends the selected requirement's `payTo`, network, asset, amount and the URL that asked for payment to `POST https://oceanalt.com/api/decide` (free, no key) and gets back `allow`, `review` or `decline`.

```js
import { x402Client } from "@x402/fetch";
import { oceanaltBeforePaymentHook } from "@oceanalt/x402/hook";

const client = new x402Client()
  .register("eip155:*", new ExactEvmScheme(signer))
  .onBeforePaymentCreation(oceanaltBeforePaymentHook());
```

- `allow`: returns nothing; the client signs and pays.
- `decline`: returns `{ abort: true, reason }`; nothing is signed. `onReview` cannot override it.
- `review`: aborts unless `onReview(result, context)` returns exactly `true` (for example after a person approved).
- No answer in time, network or HTTP error, malformed answer, or an answer about a different address: treated as `review`. The hook fails closed.
- `onDecision(result)` receives the Ed25519-signed receipt; verify it offline with `https://oceanalt.com/.well-known/oceanalt-keys.json`.

Zero dependencies (global `fetch`; Node 18+, browsers, Deno, Bun). Tested against `@x402/core` 2.28.0 with a stub scheme: the scheme is never called on decline, review or timeout. Not affiliated with or endorsed by Coinbase or the x402 Foundation.

### Tests

`test/hook.test.mjs` runs the hook against a mocked decision endpoint and against the real `@x402/core` client with a stub scheme. It checks that the scheme is never asked to sign on decline, on review, or when no answer arrives in time.

```bash
npm i --no-save @x402/core@2.28.0
node --test test/hook.test.mjs
```

## Fetch wrapper (main entry, needs `@oceanalt/core`)

Wrap `fetch` so that, at the moment a 402 asks for money, three things happen before your payer signs:

1. the endpoint is screened (impersonated merchant endpoints hand agents freshly generated payee addresses — address lists never catch those);
2. the seller's **signed payment requirements** are verified offline (`extensions.signedRequirements`, Ed25519) — a `payTo` swapped by a proxy, CDN or compromised SDK is rejected;
3. the payee gets a pre-settlement decision (`allow | review | decline`).

Secrets never leave the agent (outgoing bodies are scanned). You keep your own x402 payer; OceanAlt holds no keys and moves no money.

```js
import { OceanAltClient } from "@oceanalt/core";
import { wrapFetch } from "@oceanalt/x402";
const client = new OceanAltClient();
const fetchGuarded = wrapFetch(fetch, { client, requireSignature: false, pay: (pr) => myPayer.headersFor(pr) });
const res = await fetchGuarded("https://seller.example/api/thing");
```

`mode: "block"` (default) throws on risky endpoints, tampered requirements, declined or under-review payees; `mode: "advise"` records and lets you decide. Every call leaves an intent → decision → outcome record via `client.record()`.

## Source

`hook.mjs`, `hook.d.ts`, `index.mjs`, `index.d.ts` and `package.json` are identical to the published npm package [`@oceanalt/x402`](https://www.npmjs.com/package/@oceanalt/x402) 0.3.0. The hook (`@oceanalt/x402/hook`) has no dependencies; the fetch wrapper (main entry) needs the client [`@oceanalt/core`](https://www.npmjs.com/package/@oceanalt/core) as a peer dependency.

MIT © OceanAlt

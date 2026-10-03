# @oceanalt/x402

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

`index.mjs`, `index.d.ts` and `package.json` are identical to the published npm package [`@oceanalt/x402`](https://www.npmjs.com/package/@oceanalt/x402) 0.2.0. It needs the client [`@oceanalt/core`](https://www.npmjs.com/package/@oceanalt/core) as a peer dependency.

MIT © OceanAlt

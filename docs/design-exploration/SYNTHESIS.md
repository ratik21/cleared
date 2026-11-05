# How the architecture in PLAN.md was chosen

These candidates predate two later changes. The project was renamed from Paid to Cleared, and it moved from the Whitechain "Payments Nobody Notices" track with a hidden client wallet to the Operate track with the client's own wallet. The settlement contract design didn't change. `PLAN.md` is the current version.

Four design candidates were written in parallel from the same brief (`GROUNDING.md`), each on a different model. `PLAN.md` uses candidate 3 as the base, with grafts from the other three.

## Where all four agreed

All four candidates arrived at the same payment core without seeing each other:

- A small settlement contract with no owner calls USDT `receiveWithAuthorization`, with `to` set to the contract.
- The EIP-3009 nonce is a hash of the invoice and payee (and in three of four, the amount), so the client's one signature fixes who gets paid.
- A write-ahead row stores the signed relayer transaction before broadcast, so a crash or retry resends the same bytes.
- A browser-only key signs for the client, because no embedded wallet or bundler supports chain 1874.

Because they converged, the core was adopted as is.

## Base: candidate 3

Candidate 3 is one Next.js process with SQLite and the relayer loop running inside it. It has the fewest moving parts of the four. It's also the only one that came with a staffing plan, a pure drain guard, and a fallback for each spike decided ahead of time. Its nonce also includes a version tag, the chain ID and the contract address, so a signature can't be replayed on another deployment.

## Grafts

| Source | What was taken |
| --- | --- |
| Candidate 1 | A secret `PayToken` in the pay link, separate from the public on-chain invoice ID. The 0.5% fee capped at 2 USDT, with a 5 USDT minimum, so each settlement pays its own gas. The `/proof` page that lists every 0G request ID. WhatsApp `wa.me` links for reminders. |
| Candidate 2 | `Traced<T>` with `trustMode: 'private'` as a literal type, so a non-private AI result can't be represented. A reply that claims "paid" is checked against the chain instead of trusted. All user chain reads happen in the browser. |
| Candidate 4 | Yesterday's plan seeded so the "come back tomorrow" view has history in the demo. Every send goes through a human approval gate. A transfer-return check in the contract, added as `_safeTransfer`. |

## What was rejected

- **Candidate 4's relayer-only `settle()`.** Restricting `settle()` to the relayer adds a privileged key and buys nothing, because the signature already binds the payee and amount. Candidate 4's multi-turn agent loop with tool calls was also rejected: it's slower, harder to demo reliably, and code already decides tone and timing.
- **Candidate 4's Postgres and multi-package layout.** More infrastructure than 36 hours allows.
- **Candidate 1's Privy embedded wallet for the client.** It isn't verified to work on chain 1874.
- **Candidate 1's event-sourced log.** Too much machinery for this scope. Derived state from records plus attempts gives the same guarantee with less code.
- **Candidate 2's unprefixed nonce `keccak256(invoiceId, payee)`.** Without domain separation, a signature could be replayed on a second deployment.

## Review status

A judge on a different model family (Fable) read all four candidates and scored them on six criteria. It recommended the same base.

| Candidate | Score (out of 30) |
| --- | --- |
| Candidate 3 | 30 |
| Candidate 1 | 27 |
| Candidate 2 | 26 |
| Candidate 4 | 21 |

Three of its grafts were added to `PLAN.md` after the review: `ai_calls` stores `invoice_id`, pay links are stored only as `sha256(token)`, and branded relayer stages make `broadcast` accept only a simulated attempt. Its other grafts were already in the plan. It found no candidate with a wrong token address, trust-mode header, EIP-712 domain, model privacy class or iAI port.

The Whitechain explorer verifier (Blockscout at `https://explorer.testnet.whitechain.io/api/`) and the official RPC were confirmed separately from Whitechain's docs.

# Paid, candidate 3: "one process, one file, chain as truth"

Shape in one picture. One Next.js process, one SQLite file, one contract. The browser talks to the chain only through Anon-RPC. The relayer is a loop inside the same process.

```
 Freelancer browser                         Client browser (hidden wallet)
 ┌───────────────────────┐                  ┌───────────────────────────┐
 │ Privy(0G) login        │                  │ /i/<token>  pay page       │
 │ MediaRecorder voice    │                  │ localStorage key           │
 │ Anon-RPC ChainReader ◄─┼──── Tor ────────►│ Anon-RPC ChainReader       │
 └───────┬───────────────┘                  └──────────┬────────────────┘
         │ HTTPS (route handlers = thin adapters)        │ signs EIP-3009 once
         ▼                                               ▼
 ┌──────────────────────────── ONE Next.js process (Fly/Railway VM, or localhost) ─────────┐
 │ src/server/  invoices · payments · collections · ai(0G) · relayer loop (instrumentation)  │
 │ SQLite (better-sqlite3, WAL, volume)         relayer key (env) ── direct RPC, disclosed   │
 └──────────────┬───────────────────────────────────────────────┬──────────────────────────┘
                │ chat/completions, audio/transcriptions         │ settle(...) tx, gas in WBT
                ▼                                               ▼
        router-api.0g.ai (private TEE)           PaidSettlement on chain 1874 ──► official USDT 0xcedf…55a7
                                                 receiveWithAuthorization(from→contract) then transfer(payee)
```

## Problem

Indian freelancers bill foreign clients and lose weeks to chasing and to rails that charge and delay. We must ship, in ~36 hours with 2-3 people, one product that wins three sponsor tracks at once and demos in under 3 minutes: voice note to invoice (0G private AI), a no-gas one-signature USDT payment on Whitechain Sepolia (chain 1874) through our own verified contract, a collections agent that is the reason to return tomorrow, and a dashboard whose chain reads go through Anon-RPC by default. Constraints from grounding that shape everything: official USDT 0xcedf…55a7 must settle in the main flow; EIP-3009 is supported there; no embedded-wallet vendor or bundler supports 1874 (so no ERC-4337); 0G Privy sign-in only works on localhost; the relayer must be drain-proof in one slide; settlement must survive double clicks, retries and crashes; fallbacks must be honest.

The load-bearing idea: the payer's EIP-3009 `nonce` is a hash that commits to `(invoiceId, payee, amount)`. The contract recomputes that hash, so the payer's one signature cryptographically binds the payee and amount. The relayer therefore needs no trust, the contract needs no owner or invoice registry, and the on-chain nonce plus a `settled[invoiceId]` flag is the idempotency backstop.

---

## Usage (caller's view)

Written first. The types below are derived from these call sites.

### Freelancer (React, `src/app/(app)/...`)

```tsx
// New invoice: hold-to-record, one call, review screen
const { startRecording, stopRecording } = useVoiceNote();
const draft = await api.invoices.draftFromVoice(audioBlob);
//  -> { invoice: DraftInvoice, transcript: string, receipts: AiReceipt[] }
//     receipts[i].requestId is the 0G request_id, rendered as a "private AI" chip

await api.invoices.update(draft.invoice.id, { items, dueAt, note });   // edit in review UI
const sent = await api.invoices.send(draft.invoice.id);
//  -> { publicUrl: "https://paid.app/i/9f3k…", invoiceId: "0x…" }   // state flips draft -> open, terms frozen

// Dashboard: instant from DB, then upgraded by private chain reads
const rows = useInvoices();                       // server view, each row has state + chain: 'unverified'|'verified'
const reader = usePrivateChain();                 // { state: 'booting'|'ready'|'degraded', meter }
useEffect(() => { if (reader.state === 'ready') verifyOnChain(rows) }, [reader.state]);
// verifyOnChain = reader.settlements(rows.map(r => r.invoiceId)); one multicall3 eth_call through Tor
```

### Client (pay page `src/app/i/[token]/page.tsx`, zero crypto words in UI)

```tsx
const view = await api.pay.view(token);           // { invoice: PublicInvoice, payable: true, feePct: "0.30" }
const wallet = getHiddenWallet();                 // localStorage key, created silently on first visit
const onPayClick = async () => {
  const auth = await signPayment(wallet, view.invoice);   // ONE EIP-712 signature, no popup, no gas
  const { attemptId } = await api.pay.submit(token, auth); // idempotent: double click returns the same attemptId
  await watchSettlement(view.invoice.invoiceId);           // polls settlements(id) through Anon-RPC
};
// Machine payer (AI agent) uses the same HTTP call: scripts/agent-pay.ts is ~30 lines over signPayment + api.pay.submit
```

### Collections agent (daily, `src/app/(app)/today/page.tsx` and server)

```ts
// Page load calls this; it is cached per (user, local date) so reload does not re-bill 0G
const plan = await collections.planToday(userId);
// -> CollectionsPlan { date, items: [{ invoiceId, tier: 'friendly'|'firm'|'final', daysLate,
//                                       draft: { subject, body, lang }, receipt: AiReceipt }] }

await collections.approveSend(userId, item.draftId, { channel: 'mailto' | 'copy' });  // freelancer approves each send

// Client replied by email; freelancer pastes it
const proposal = await collections.readReply(userId, invoiceId, pastedText);
// -> ReplyProposal { intent: {kind:'promised', date:'2026-11-14'} | {kind:'disputed',reason} | {kind:'paid_claimed'}
//                    | {kind:'asks_extension', date} | {kind:'unclear'}, receipt: AiReceipt, patch: CollectionNotePatch }
await collections.applyProposal(userId, proposal.id);   // writes a CollectionNote; never marks anything paid
```

### Anon-RPC read path (the only chain-read entry point for UI code)

```ts
const reader = await getPrivateChainReader();     // lazy Tor bootstrap, memoized, never blocks pay flow
const sets = await reader.settlements(ids);       // Map<InvoiceId, Settlement | null>
const bal  = await reader.usdtBalance(addr);
reader.meter.subscribe(m => setBadge(m));         // { privateReads: 31, directReads: 0 } this session
```

---

## Shape

### Stack (fewest moving parts)

| Concern | Choice | Why |
|---|---|---|
| App + API | Next.js 15 App Router, TypeScript strict, route handlers as 5-line adapters | one repo, one deploy, one process |
| Data | SQLite via `better-sqlite3` + `drizzle-orm` (schema is the single source of row types), WAL, on a Fly/Railway volume | zero infra; single-writer is exactly what the relayer nonce needs |
| Relayer | `startRelayerLoop()` called from `src/instrumentation.ts`, guarded by a `globalThis` singleton | no second service, no queue broker; SQLite rows are the queue |
| Chain | `viem`; Foundry for the contract; `forge verify-contract` | viem `signTypedData`, `simulateContract`, `encodeAbiParameters` cover all needs |
| AI | `ZeroGClient` using plain `fetch` to `https://router-api.0g.ai/v1`, `zod` for response parsing | OpenAI-compatible; no SDK dependency to fight |
| Auth | Privy (0G app id) on localhost; demo-persona login on the hosted URL; both mint one session cookie | iAI bonus without breaking the hosted link |
| Anon-RPC | `AnonRpcWorker` in the browser, wrapped by one `PrivateChainReader` | user-attributable traffic is the traffic that matters |
| UI | Tailwind + shadcn/ui, `MediaRecorder` webm/opus | speed |
| Tests | Vitest (pure domain + relayer guard + settle-nonce golden), Foundry tests (contract) | test behavior only where bugs cost money |

Hosting. Hosted live link runs on one VM with a volume (not Vercel: long-lived loop plus SQLite file). Judges' 0G bonus runs the same repo on `localhost:3000`. Same code, one env flag (`AUTH_MODE=privy|demo`).

### Module map (file paths; owner letter = who builds it, see Build plan)

```
paid/
  README.md  WHITECHAIN_FEEDBACK.md  .env.example  deployments/1874.json
  contracts/                                   [A]
    foundry.toml                               solc 0.8.24, evm_version=paris, optimizer 200, bytecode_hash=none
    src/PaidSettlement.sol                     zero imports, single file (trivial verification)
    test/PaidSettlement.t.sol                  mock 3009 token + fork test against 0xcedf on 1874
    script/Deploy.s.sol
  scripts/                                     [A]
    gen-abi.ts            forge out -> src/chain/abi.generated.ts (derive, never hand-write ABI)
    fund-client.ts        sends demo USDT + nothing else to a client wallet address
    agent-pay.ts          headless payer, same signPayment + HTTP call
    spike-*.ts            hour-0 risk spikes (see Open questions)
  src/
    domain/                                    pure, no I/O, no framework imports      [A+C]
      ids.ts              branded ids + parsers
      money.ts            UsdtAtoms, parseUsd, formatUsd, sumItems (bigint only)
      invoice.ts          Invoice types, InvoiceState, deriveState, canSend, canVoid
      attempt.ts          PaymentAttempt machine, assertTransition table
      settle-nonce.ts     settleNonce(); the TS twin of PaidSettlement.nonceFor
      lateness.ts         daysLate, tierFor (deterministic tone policy)
      collections.ts      ReplyIntent union, CollectionNotePatch, planShape
    chain/                                     [A]
      whitechain.ts       chain 1874 def, USDT, SETTLEMENT addresses, USDT_DOMAIN (hardcoded)
      eip3009.ts          signPayment() (browser/agent) + recoverPayment() (server)
      abi.generated.ts    generated
    server/                                    server-only (`import 'server-only'`)
      db/schema.ts        drizzle tables (single source of row types)
      db/index.ts         the one connection, pragmas, migrate-on-boot
      auth.ts             Credential union -> Session; Privy verify; demo login
      invoices.ts         draftFromVoice, update, send, void, list (deep module)       [B]
      payments.ts         submitPayment (idempotent intake), statusOf                   [A]
      collections.ts      planToday, approveSend, readReply, applyProposal              [C]
      ai/zerog.ts         ZeroGClient: transcribe(), chatJson(); request_id capture     [C]
      ai/prompts.ts       prompt builders (structured state in, string out)             [C]
      ai/ledger.ts        recordAiCall() -> ai_calls row, creditsUsed(userId)           [C]
      relayer/loop.ts     startRelayerLoop, tick(): intake -> sign -> broadcast -> confirm
      relayer/guard.ts    admit(): pure drain-prevention decision                       [A]
      relayer/rpc.ts      direct viem client, counted into rpc_meter (disclosed)
    client/                                    browser only                            [C]
      chain-reader.ts     PrivateChainReader over AnonRpcWorker + meter
      hidden-wallet.ts    getHiddenWallet() localStorage key
      voice.ts            useVoiceNote()
      api.ts              typed fetch client (zod-parsed responses)
    app/                                       [B]
      (app)/today/page.tsx   collections plan, the "come back tomorrow" screen
      (app)/invoices/...     list/dashboard, new (voice), [id] review
      i/[token]/page.tsx     client pay page
      api/**/route.ts        one file per operation; parse -> call server/* -> serialize
    instrumentation.ts       starts relayer loop once
```

Import rules, enforced by `eslint-plugin-boundaries` plus `server-only`: `domain` imports nothing; `chain` imports `domain`; `server` imports `domain`+`chain`; `client` imports `domain`+`chain/eip3009`+`chain/whitechain` only; `app/api` imports `server`; no one imports `server/**` internals except through `server/{invoices,payments,collections}.ts`. Call chain for any user action: route handler -> one deep service function -> domain pure function + db. Three files at most.

### Domain types (TypeScript sketch)

```ts
// src/domain/ids.ts
declare const brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [brand]: B };
export type UserId      = Brand<string, 'UserId'>;
export type Address     = Brand<`0x${string}`, 'Address'>;          // checksummed
export type InvoiceId   = Brand<`0x${string}`, 'InvoiceId'>;        // bytes32, onchain key, keccak(uuid)
export type PublicToken = Brand<string, 'PublicToken'>;             // 22-char url-safe, the pay link
export type TxHash      = Brand<`0x${string}`, 'TxHash'>;
export type Nonce32     = Brand<`0x${string}`, 'Nonce32'>;          // EIP-3009 nonce = settleNonce(...)
export type AttemptId   = Brand<string, 'AttemptId'>;
export type ZgRequestId = Brand<string, 'ZgRequestId'>;             // x_0g_trace.request_id
export type UsdtAtoms   = Brand<bigint, 'UsdtAtoms'>;               // 6 decimals, bigint only
export const parseAddress: (raw: unknown) => Address = () => { throw new Error('not implemented'); };
export const parseInvoiceId: (raw: unknown) => InvoiceId = () => { throw new Error('not implemented'); };

// src/domain/money.ts
export const USDT_DECIMALS = 6 as const;
export function parseUsd(decimal: string): UsdtAtoms { throw new Error('not implemented'); } // "600" | "600.50"; rejects >6dp, negatives
export function sumItems(items: readonly LineItem[]): UsdtAtoms { throw new Error('not implemented'); }
// AI emits qty:number and unitPriceUsd:string. Code, never the model, computes totals.

// src/domain/invoice.ts
export interface LineItem { description: string; qty: number; unitPrice: UsdtAtoms; }
export interface Client   { name: string; email?: string; lang: 'en' | 'hinglish'; }

interface InvoiceBase {
  id: InvoiceId; ownerId: UserId; client: Client; items: readonly LineItem[];
  payee: Address;               // freelancer's Privy embedded wallet at send time (frozen)
  amount: UsdtAtoms;            // == sumItems(items), derived once at send, frozen
  dueAt: string;                // ISO date
  note?: string; createdAt: string;
}
/** Stored record: only three kinds. 'paying', 'paid', 'overdue' are NOT stored. */
export type InvoiceRecord =
  | (InvoiceBase & { kind: 'draft'; transcript?: string })
  | (InvoiceBase & { kind: 'open'; token: PublicToken; sentAt: string; termsHash: `0x${string}` })
  | (InvoiceBase & { kind: 'void'; voidedAt: string });

/** Derived view. Single source of truth: attempts + chain, never a status column. */
export type InvoiceState =
  | { kind: 'draft' }
  | { kind: 'open'; overdue: false }
  | { kind: 'open'; overdue: true; daysLate: number }
  | { kind: 'paying'; attemptId: AttemptId; txHash?: TxHash }
  | { kind: 'paid'; txHash: TxHash; paidAt: string; chain: 'unverified' | 'verified' }
  | { kind: 'void' };

export function deriveState(r: InvoiceRecord, attempts: readonly PaymentAttempt[], now: Date): InvoiceState {
  // paid  iff an attempt is 'confirmed'  (confirmed is only written with a success receipt or a settlements() hit)
  // paying iff an attempt is 'queued'|'broadcast'
  // overdue iff open && now > dueAt && no paid/paying attempt
  throw new Error('not implemented');
}
export const canSend = (r: InvoiceRecord): r is Extract<InvoiceRecord, { kind: 'draft' }> => r.kind === 'draft';

// src/domain/attempt.ts   (payment-attempt state machine)
export type AttemptState = 'queued' | 'broadcast' | 'confirmed' | 'failed' | 'expired';
export const ATTEMPT_TRANSITIONS: Record<AttemptState, readonly AttemptState[]> = {
  queued:    ['broadcast', 'failed', 'expired'],
  broadcast: ['broadcast', 'confirmed', 'failed', 'expired'], // self-edge = fee-bump replacement
  confirmed: [], failed: [], expired: [],                      // terminal
};
export function assertTransition(from: AttemptState, to: AttemptState): void { throw new Error('not implemented'); }

export interface SignedPayment {           // what the browser/agent sends; no transport types leak past api.ts
  from: Address; value: UsdtAtoms; validAfter: bigint; validBefore: bigint; nonce: Nonce32;
  signature: `0x${string}`;                // 65 bytes, split to v,r,s server-side
}
export interface PaymentAttempt {
  id: AttemptId; invoiceId: InvoiceId; state: AttemptState; payment: SignedPayment;
  rawTx?: `0x${string}`; txHash?: TxHash; txNonce?: number;  // persisted BEFORE broadcast
  gasUsed?: bigint; attempts: number; createdAt: string; failure?: string;
}

// src/domain/settle-nonce.ts: the load-bearing hash
export function settleNonce(p: { chainId: 1874; settlement: Address; invoiceId: InvoiceId; payee: Address; value: UsdtAtoms }): Nonce32 {
  // keccak256(abi.encode(bytes32 "PAID_SETTLE_V1", uint256 chainId, address settlement, bytes32 invoiceId, address payee, uint256 value))
  throw new Error('not implemented');
}

// src/domain/lateness.ts: deterministic policy; the model only writes words
export type Tier = 'friendly' | 'firm' | 'final';
export const tierFor = (daysLate: number): Tier => (daysLate < 7 ? 'friendly' : daysLate < 21 ? 'firm' : 'final');

// src/domain/collections.ts
export type ReplyIntent =
  | { kind: 'promised'; date: string }
  | { kind: 'asks_extension'; date: string }
  | { kind: 'disputed'; reason: string }
  | { kind: 'paid_claimed' }
  | { kind: 'unclear' };
export interface CollectionNote { invoiceId: InvoiceId; promisedDate?: string; disputed?: string; lastContactAt?: string; }
export type CollectionNotePatch = Partial<Omit<CollectionNote, 'invoiceId'>>;
export const patchFor = (i: ReplyIntent, today: string): CollectionNotePatch => { throw new Error('not implemented'); };
// 'paid_claimed' yields only a "check chain" prompt. Only chain evidence moves an invoice to paid.

export interface AiReceipt {                // one per 0G call that touched this feature
  kind: AiKind; requestId: ZgRequestId | null; provider?: string; teeVerified?: boolean;
  creditsMicro?: number; model: string; at: string;
}
export type AiKind = 'transcribe' | 'draft_invoice' | 'collections_plan' | 'classify_reply';
```

Encoded invariants: you cannot send a non-draft (`canSend` is a type guard); `paid` cannot be written, only derived; attempts cannot move backwards (`ATTEMPT_TRANSITIONS` plus a DB `CHECK` and the one `setAttemptState()` writer); amounts are `bigint` branded atoms so a float never reaches the chain; payee/amount in `InvoiceRecord` are frozen at send, and `settleNonce` binds them to the signature. Per type-system-discipline and model-the-domain: a status column was rejected in favor of derivation, so "paid but no tx" cannot exist.

### Data (SQLite, drizzle in `src/server/db/schema.ts`)

```
users(id pk, privy_id unique, payee_address, display_name, created_at)
invoices(id pk=bytes32, owner_id fk, kind check in (draft,open,void), token unique null, client_json, items_json,
         payee, amount_atoms text, due_at, note, transcript, terms_hash, sent_at, created_at, voided_at)
payment_attempts(id pk, invoice_id fk, state check in (...), payer, value_atoms, valid_after, valid_before,
         nonce, signature, raw_tx, tx_hash unique null, tx_nonce, attempts int, gas_used, failure, created_at)
  UNIQUE INDEX one_live_attempt ON payment_attempts(invoice_id) WHERE state IN ('queued','broadcast','confirmed')
ai_calls(id pk, user_id, kind, request_id, provider, tee_verified, zg_res_key, model, billing_json, ok, error, latency_ms, created_at)
collection_plans(user_id, local_date, plan_json, primary key(user_id, local_date))     -- daily cache
collection_drafts(id pk, invoice_id, tier, subject, body, lang, state check in (drafted,approved,sent), created_at)
collection_notes(invoice_id pk, promised_date, disputed, last_contact_at)
gas_ledger(id pk, tx_hash unique, gas_used, fee_wei text, day text, created_at)
rpc_meter(source text, day text, count int, primary key(source, day))                  -- 'relayer-direct' etc.
```

The partial unique index is the DB-level statement of "at most one live payment per invoice". Per separate-before-serializing-shared-state: all rows are per-invoice or per-user. The only genuinely shared state is the relayer's account nonce, serialized by the single relayer loop (one writer is a real invariant here, see Tradeoffs).

### Solidity: `contracts/src/PaidSettlement.sol`

Deployable and verifiable on chain 1874 by construction: zero imports (flat single file), no proxies, no libraries, `evm_version = paris` (no PUSH0 surprises on a chain whose fork level is unverified), `bytecode_hash = none` and pinned solc so the explorer's recompile matches. Settles the official USDT through EIP-3009 `receiveWithAuthorization`, which reverts unless `msg.sender == to`, so only this contract can consume a payer's signature. No owner, no upgrade, no admin function: nothing for a relayer or a team member to abuse.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IUSDT3009 {
    function receiveWithAuthorization(
        address from, address to, uint256 value,
        uint256 validAfter, uint256 validBefore, bytes32 nonce,
        uint8 v, bytes32 r, bytes32 s) external;
    function transfer(address to, uint256 value) external returns (bool);
    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool);
}

contract PaidSettlement {
    IUSDT3009 public immutable USDT;       // 0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7 on 1874
    address   public immutable FEE_TO;     // Paid treasury; fee pays the relayer's gas in the business model
    uint16    public immutable FEE_BPS;    // <= 100 (1%), set in constructor, never mutable

    struct Settlement { address payer; address payee; uint128 value; uint64 paidAt; }
    mapping(bytes32 invoiceId => Settlement) public settlements;   // the on-chain truth the dashboard reads

    event InvoiceSettled(bytes32 indexed invoiceId, address indexed payer, address indexed payee, uint256 value, uint256 fee);

    error AlreadySettled(); error BadFee(); error TransferFailed(); error ZeroValue();

    constructor(address usdt, address feeTo, uint16 feeBps) { /* require feeBps <= 100; assign immutables */ }

    /// Commitment the payer signs as the EIP-3009 nonce. Binds invoice, payee, amount, chain, contract.
    function nonceFor(bytes32 invoiceId, address payee, uint256 value) public view returns (bytes32) {
        return keccak256(abi.encode(bytes32("PAID_SETTLE_V1"), block.chainid, address(this), invoiceId, payee, value));
    }

    /// Permissionless. Anyone may submit (and pay the gas for) a payer's signature; no one can redirect it,
    /// because the payee/value are inside the signed nonce.
    function settle(
        bytes32 invoiceId, address payer, address payee, uint256 value,
        uint256 validAfter, uint256 validBefore, uint8 v, bytes32 r, bytes32 s
    ) external {
        // 1. if (settlements[invoiceId].paidAt != 0) revert AlreadySettled();      (idempotency backstop #1)
        // 2. if (value == 0 || value > type(uint128).max) revert ZeroValue();
        // 3. bytes32 nonce = nonceFor(invoiceId, payee, value);
        // 4. USDT.receiveWithAuthorization(payer, address(this), value, validAfter, validBefore, nonce, v, r, s);
        //      token reverts on reused nonce, bad sig, expired window  (idempotency backstop #2)
        // 5. fee = value * FEE_BPS / 10_000; send (value-fee) to payee, fee to FEE_TO via _safeTransfer
        // 6. settlements[invoiceId] = Settlement(payer, payee, uint128(value), uint64(block.timestamp));
        // 7. emit InvoiceSettled(...)  -- whole tx atomic: if step 5 fails, step 4 is rolled back, no stranded funds
        revert("not implemented");
    }

    function isSettled(bytes32 invoiceId) external view returns (bool) { return settlements[invoiceId].paidAt != 0; }

    function _safeTransfer(address to, uint256 amt) private { /* low-level call, accept empty or true return; else revert TransferFailed */ }
}
```

Deploy: `forge create` or `Deploy.s.sol` with `--chain 1874 --rpc-url https://rpc.testnet.whitechain.io`; then `forge verify-contract --chain-id 1874 --verifier blockscout --verifier-url <explorer>/api` (explorer family unverified, see risks). Deployed address goes into `deployments/1874.json`, imported by `src/chain/whitechain.ts` (one source, no env copy). The Foundry test suite has: nonce parity vector with the TS golden; double settle reverts; wrong payee/value revert (nonce mismatch); front-run (`receive` called by a non-contract) impossible; fee math; a fork test against the real USDT on 1874 that calls `authorizationState`.

### Relayer drain prevention (one slide)

The slide: "The relayer key can only ever send one thing, `settle()`, for an invoice that exists in our DB, with arguments we read from our DB, after an `eth_call` proves it succeeds, inside a daily gas budget. The only way to spend relayer gas is to actually move a payer's real USDT to a real freelancer."

```
 request ──► admit() [pure, relayer/guard.ts] ──► simulate (eth_call) ──► sign+persist rawTx ──► broadcast
```

```ts
// src/server/relayer/guard.ts
export type Admission = { ok: true } | { ok: false; reason: RejectReason };
export type RejectReason =
  | 'unknown_invoice' | 'not_open' | 'amount_mismatch' | 'bad_signature' | 'wrong_recipient'
  | 'wrong_nonce' | 'window_invalid' | 'payer_balance_low' | 'attempt_cap' | 'payer_rate' | 'daily_budget' | 'relayer_low';

export interface GuardInput {
  invoice: Extract<InvoiceRecord, { kind: 'open' }>;     // from DB. Request supplies NONE of payee/amount/invoice terms.
  payment: SignedPayment; now: number;
  payerBalance: UsdtAtoms; priorAttemptsForInvoice: number; payerAttemptsLastHour: number;
  gasSpentTodayWei: bigint; relayerBalanceWei: bigint; limits: RelayerLimits;
}
export interface RelayerLimits {
  maxAttemptsPerInvoice: 3; maxAttemptsPerPayerPerHour: 10; dailyGasBudgetWei: bigint;
  txGasLimit: 250_000n; maxFeePerGasWei: bigint; minRelayerBalanceWei: bigint; maxValidityWindowSec: 3600;
}
export function admit(i: GuardInput): Admission { throw new Error('not implemented'); }
```

Layers, in order, each cheap before expensive:

1. Invoice comes from our DB by `PublicToken`; `payee` and `amount` are read from it. A caller cannot name a payee or amount. No endpoint takes a target address or calldata.
2. `recoverPayment` (viem `verifyTypedData`) proves the signature is from `from`, `to == SETTLEMENT`, `value == invoice.amount`, `nonce == settleNonce(...)`, `validBefore - now <= 1h`. Garbage requests die here with zero gas and zero RPC.
3. Payer USDT balance read (direct) >= value. Insufficient balance never reaches chain.
4. `simulateContract(settle)` must succeed at the current block. A failing signature costs nothing.
5. Budgets: <= 3 attempts per invoice (also the partial unique index), <= 10 per payer per hour, daily gas budget from `gas_ledger`, hard `gas = 250_000` and `maxFeePerGas` cap, relayer balance floor (below it intake pauses, UI shows "temporarily unavailable", no fake success).
6. Contract: no function lets the relayer's own funds move; `settle` is permissionless but only the payer's signed USDT moves, to the signed payee.

Residual: a payer can sign valid, then drain their own USDT between simulation and mining, costing one failed tx (~84k gas per the live proof). Bounded by 1 in-flight attempt per invoice, the per-payer limit and the daily budget.

How the business pays gas and how the relayer gets WBT: relayer EOA is funded from the team's faucet claims (0.5 WBT/day each) for the hackathon; in production the contract's `FEE_BPS` (demo: 30 bps, shown to the payer as "Paid fee") accrues in USDT at `FEE_TO`, a treasury job swaps to WBT and tops the relayer up. Gas per settlement measured at ~85-150k; the README states the break-even invoice size.

### Idempotency story for settlement

Five independent layers; any one is enough to prevent a double payment, together they make every retry converge.

```
 click ─► api.pay.submit
          │ (1) intake: INSERT payment_attempts ... ON CONFLICT DO NOTHING  (partial unique index one_live_attempt)
          │     double click / duplicate request ─► returns the existing attemptId, no new row
          ▼
 relayer tick, per queued attempt, in order:
   (2) preflight: read settlements(invoiceId) and USDT.authorizationState(payer, nonce). If used ─► state=confirmed (recover txHash from the InvoiceSettled log), stop.
   (3) assign txNonce = max(chain pending nonce, db max+1); sign tx locally; persist {rawTx, txHash, txNonce, state=broadcast} in ONE sqlite transaction BEFORE sendRawTransaction.
   (4) broadcast rawTx. "already known"/"nonce too low with same hash" counts as success.
   (5) confirm: receipt status 1 ─► state=confirmed + gas_ledger row. status 0 ─► failed. Not mined in 90s ─► rebroadcast the SAME rawTx; after 5 min bump fee (new rawTx, self-edge broadcast->broadcast, same txNonce so only one can mine).
 contract: settled[invoiceId] flag + EIP-3009 nonce are the final backstop even if all of the above were wrong.
```

Crash matrix (each row is a test in `relayer/loop.test.ts` using a fake chain):

| Crash point | On restart |
|---|---|
| after intake insert, before preflight | row is `queued`: tick resumes at (2) |
| after sign, before broadcast | row `broadcast` with rawTx: tick rebroadcasts the same bytes, same hash |
| after broadcast, before DB write of confirmation | tick polls receipt for stored txHash, writes `confirmed` |
| tx dropped from mempool | rebroadcast; if validBefore passed and nonce unused -> `expired`, payer signs again |
| tx reverted on chain | `failed`; invoice returns to `open`; new signature allowed (partial index frees the slot) |
| DB says confirmed but chain disagrees | impossible: `confirmed` is only written from a success receipt or a `settlements()` hit; a reconcile pass every 15s re-reads `settlements()` for all non-void open invoices with any attempt, and `deriveState` reads attempts only |

The browser never trusts the server for "paid": `watchSettlement` polls `settlements(invoiceId)` over Anon-RPC and shows a "verified privately on-chain" badge when it hits. Server status and chain badge are separate on purpose (DB is a cache of the chain, never the other way).

### Anon-RPC read path

```ts
// src/client/chain-reader.ts: the only module that may create a chain read client in the browser
export type ReaderState = 'booting' | 'ready' | 'degraded';
export interface ReadMeter { privateReads: number; directReads: number; }   // directReads is non-zero only if the user flips "Read directly"
export interface PrivateChainReader {
  readonly state: ReaderState;
  settlements(ids: readonly InvoiceId[]): Promise<ReadonlyMap<InvoiceId, OnchainSettlement | null>>; // ONE multicall3 aggregate3 eth_call
  usdtBalance(addr: Address): Promise<UsdtAtoms>;
  meter: Subscribable<ReadMeter>;
}
export interface OnchainSettlement { payer: Address; payee: Address; value: UsdtAtoms; paidAt: number; }
export function getPrivateChainReader(): Promise<PrivateChainReader> { throw new Error('not implemented'); }
```

Construction (pseudocode):

```ts
const worker = new AnonRpcWorker({ address: TOR_JS_SPECIFIER, config: { gateways }, preExisting: { rpcProvider: mainnetProvider } });
const client = createPublicClient({ chain: whitechainSepolia,
  transport: http(RPC_ANKR_1874, { fetchFn: async (u, i) => { meter.private++; return worker.fetch(u, i); } }) });
// if viem rejects fetchFn: transport = custom({ request: ({method, params}) => rpcOverWorkerFetch(worker, RPC, method, params) })
```

Decisions:
- Browser-side, not server-side. Anon-RPC hides the reader's IP and which addresses/invoices they query from the RPC operator. A server-side Tor client would hide nothing that matters (the server's IP is already known) and would count against us on "technical depth". Browser reads are the user's traffic.
- Reads are designed to be few and batched so Tor latency is tolerable: one `aggregate3` multicall for N invoices; no log scans; pay flow needs zero reads (domain hardcoded, nonce deterministic, no balance gating).
- Default is private with honest degradation: while `booting`, UI shows DB data labeled "not yet verified on-chain" with a skeleton badge. If bootstrap fails, state `degraded`: same labeled DB data plus an explicit "Read directly (not private)" button. It never silently falls back. That button increments `directReads`, visible in the badge.
- Disclosed exclusions (README "Privacy and limitations"): (1) the one-time bootstrap read that resolves the Tor specifier from mainnet/Sepolia is not anonymized; (2) the relayer's own reads/writes go direct (`relayer/rpc.ts`, counted into `rpc_meter`), since that traffic is Paid's infrastructure, not a user's. User-attributable share = 100% via Anon-RPC; the badge shows both numbers.
- Writes: the client never sends a transaction. Relayer broadcasts. Nothing user-attributable leaves except through the worker.

### 0G call shapes (`src/server/ai/zerog.ts`)

All calls: base `https://router-api.0g.ai/v1`, `Authorization: Bearer ${key}`, header `X-0G-Provider-Trust-Mode: private`. A 503 `no_provider_for_trust_mode` surfaces as `PrivateProviderUnavailable` and the UI says so; there is no non-private fallback and no fake output. `resolveKey(user)` returns the user's iAI key when the 0G account flow yields one, else the team key (see risks).

```ts
export interface ZgTrace { requestId: ZgRequestId; provider: string; billing: unknown; teeVerified?: boolean; zgResKey?: string; }
export interface ZeroGClient {
  transcribe(audio: Blob, ctx: CallCtx): Promise<{ text: string; receipt: AiReceipt }>;
  chatJson<T>(args: { model: ZgModel; system: string; user: string; schema: z.ZodType<T>; ctx: CallCtx }): Promise<{ value: T; receipt: AiReceipt }>;
}
export type ZgModel = 'glm-5.3' | '0gm-1.0-35b-a3b';
export interface CallCtx { userId: UserId; kind: AiKind }

// transcribe: multipart POST /v1/audio/transcriptions?verify_tee=true
//   fields: file=<voice.webm>, model="whisper-large-v3"        (fallback id "openai/whisper-large-v3")
//   read trace from body.x_0g_trace; if absent, fall back to response headers (ZG-Res-Key) and store requestId=null + flag. 
//
// chatJson: POST /v1/chat/completions
//   { model:'glm-5.3', messages:[{role:'system',content:system},{role:'user',content:user}],
//     response_format:{type:'json_object'}, verify_tee:true, temperature:0.2 }
//   parse choices[0].message.content as JSON -> zod schema; on ZodError one repair retry
//   ("Your JSON failed validation: <issues>. Return corrected JSON only."), then throw AiOutputInvalid.
//   Every call (ok or error) writes an ai_calls row via ledger.recordAiCall: request_id, provider, tee_verified,
//   zg_res_key, billing_json, latency. UI renders AiReceipt as a chip "0G private · req 7f3a… · TEE verified".
```

Feature call sites (what each prompt builder gets and returns, all pure string builders in `ai/prompts.ts`):

| Function | Model call | Input | Zod output |
|---|---|---|---|
| `draftFromVoice` | `transcribe` then `chatJson('glm-5.3')` | transcript, user's saved clients, today | `{client:{name,email?}, items:[{description,qty,unitPriceUsd:string}], dueInDays?:number, note?}` |
| `planToday` | one `chatJson` per run, not per invoice | per overdue/due-soon invoice: `{invoiceId, client.name, lang, tier (from code), daysLate, amount, notes}` | `{drafts:[{invoiceId, subject, body}]}` (tier and lang are inputs, never model choices) |
| `readReply` | `chatJson` | pasted text + invoice summary + today | `ReplyIntent` (relative dates like "Friday" resolved against `today` given in the prompt, then validated as an ISO date in the future) |

What breaks if 0G is removed (README sentence): "the voice note, client identity, amounts and client replies are exactly the data a freelancer must not leak; without 0G TEE inference with zero retention, Paid would send them to a provider who can read them, and the transcript, invoice draft, reminders and reply reading disappear."

Return tomorrow: `/today` is the landing page; `planToday` is cached in `collection_plans`, so the plan changes day to day with lateness tiers (friendly, firm, final), promised dates, and new payments. Credit meter in the nav sums `ai_calls.billing_json` for the user, giving the visible "balance drops as you use it" for the iAI bonus.

### Auth

```ts
// src/server/auth.ts
export type Credential =
  | { kind: 'privy'; accessToken: string }      // AUTH_MODE=privy (localhost:3000)
  | { kind: 'demo'; persona: 'priya' | 'rahul' }; // AUTH_MODE=demo (hosted); disabled when AUTH_MODE != demo
export interface Session { userId: UserId; payee: Address; }   // payee = Privy embedded wallet, or the persona's seeded address
export function startSession(c: Credential): Promise<Session> { throw new Error('not implemented'); }
```

One Credential union, one cookie, one `requireSession()` for all handlers. The README says plainly that Privy login works only on localhost; the hosted link uses demo personas. Not hidden.

### Client hidden wallet (honest scope)

`getHiddenWallet()` creates a viem private key in `localStorage` on first visit and signs the EIP-3009 typed data locally. This is deliberately naive (documented limitation: production uses passkey smart accounts or an exchange/onramp). The demo client is a crypto startup with funded USDT: `scripts/fund-client.ts <address>` pre-funds the demo browser profile. `src/client/onramp.ts` exports `interface OnrampSeam { quote(amount): Promise<never> }` implemented as "Ask your treasury to send 600 USDT to 0x…" copy, no pretend card flow.

---

## Synthesis decision

*(left empty for arena)*

---

## Tradeoffs accepted

- We accept a single-process relayer (no horizontal scale, restart means a few seconds of pending) in exchange for removing a queue, a second deploy, and every cross-process nonce race. One writer for the relayer's tx nonce is a real invariant; SQLite rows are its durable queue.
- We accept SQLite on one VM with a volume in exchange for zero infra; no serverless hosting. Vercel is out.
- We accept a permissionless `settle()` (anyone can pay gas for anyone's signature) in exchange for a contract with no owner and a trivially explainable drain story; the relayer's DB-read terms plus simulation provide the gate off-chain, the nonce commitment on-chain.
- We accept deriving `paid`/`paying`/`overdue` instead of storing status. Slightly more query code, in exchange for no state that can disagree with the chain.
- We accept a naive localStorage hidden wallet in exchange for 100% of the demo-critical "zero crypto steps" with no vendor that supports chain 1874. Documented as a limitation, with the onramp seam left unbuilt.
- We accept that the relayer's own RPC traffic is direct (disclosed) in exchange for not running Tor in Node. User-attributable reads are 100% Anon-RPC.
- We accept a flat Solidity file with `FEE_BPS` immutable and a no-fee-change contract in exchange for fast verification and no admin surface. A fee change means redeploy.
- We accept hosted demo personas because the Privy app only works on localhost. The 0G bonus run is local.
- We accept that email delivery is `mailto`/copy (freelancer approves each send) in exchange for not integrating an ESP; looks like a missing feature, is actually the approval gate.
- We accept the TS and Solidity `settleNonce` twins in exchange for a self-checking commitment; a golden test and a fork test calling `nonceFor` keep them in lockstep. This is the one hand-synced pair.

## Alternatives considered

1. Three services: Next frontend, Fastify relayer, Postgres + queue. Rejected on interface depth and moving parts: the service boundary exposes the relayer API and a shared DB schema to two codebases, and for 36 hours the deploy and the nonce coordination cost more than any scale it buys. Same behavior lives behind one function (`submitPayment`) here.
2. ERC-4337 smart accounts plus paymaster using the deployed EntryPoint. Deep and "correct", but the grounding says the thirdweb bundler rejects 1874 and no embedded-wallet provider supports it, so we would host a bundler and write an account. Hides more complexity from the payer, but ours costs most of the build and the demo risk. EIP-3009 gives the same user-visible outcome (one signature, no gas) with a fraction of the surface.
3. Relayer EOA submitting `transferWithAuthorization` straight to the freelancer, no contract. Smallest, but the prize requires a deployed verified contract and the relayer could not be bound to payee by anything the payer signed. Our contract plus nonce commitment is strictly stronger.
4. EIP-2612 permit + `transferFrom` through a forwarder. Permit has no custom field, so payee/amount cannot be bound to the signature without trusting the relayer. Rejected.
5. Server-side Anon-RPC (Tor in Node, all reads). Simpler to demo and deterministic, but hides nothing from the RPC provider that the server's own IP does not already reveal; weaker on "UX" and "technical depth". Rejected for browser-side reads.
6. Event-sourced app where chain events are the only store. Pure, but AI drafts, transcripts and collections state are not on-chain, and Tor-read latency would make every screen slow. Chain stays the source of truth only for payment status.

## Implementation reconciliation

*(empty; filled during Phase D)*

---

## Open questions and risks

Hour-0 spikes (`scripts/spike-*.ts`, 2 hours total, run in parallel by A, C, and the Anon-RPC owner). Each has a pre-decided fallback so no spike result forces a redesign.

1. Does Tether V2 `receiveWithAuthorization` actually work on 0xcedf with the exact ABI, and is the contract-as-recipient path allowed (no blacklist, no min)? Grounding proves `transferWithAuthorization` relayed and lists the receive variant. Fallback if it fails: the payer signs `transferWithAuthorization(to = payee)` with the same committed nonce, relayer submits it directly, and `PaidSettlement` shrinks to `recordSettlement()` that verifies `authorizationState(payer, nonce)` is true and writes the registry. Weaker but still a deployed verified contract that the dashboard reads.
2. Does `/v1/audio/transcriptions` honor `X-0G-Provider-Trust-Mode: private` and return `x_0g_trace.request_id`? Only one private Whisper provider. Fallback: the voice flow keeps the recording, but the transcribe step displays "private transcription unavailable, type your invoice" (typed text goes to the same `chatJson`); the request_id requirement is still met by the LLM call, and we say so. No fake transcript.
3. Does viem's `http({ fetchFn })` accept `worker.fetch`, and does Ankr (1874) accept Tor exits? Fallback: `custom({request})` over `worker.fetch`; if Ankr blocks exits, try `rpc.testnet.whitechain.io`. If Tor is flaky on demo day, `degraded` mode plus a pre-bootstrapped tab (open `/invoices` 60 s before the demo).
4. Which explorer family does Whitechain use (Blockscout vs Etherscan-like), and does it accept `forge verify-contract`? Fallback: standard-JSON upload through its UI; the contract is flat so this is the easy case. Verify in hour 3, not hour 35.
5. Does `response_format: json_object` plus `glm-5.3` follow the schema reliably? Zod plus one repair retry covers it. json_schema is unverified and not used.
6. How does the 0G iAI "credit balance drops as they use it" work: a per-user key from the 0G Privy account, or only the team key? Unknown. Question for the 0G booth in hour 1. Until answered we show `ai_calls.billing_json` totals as "credits used" and do not claim the bonus mechanism.
7. How does the client get USDT when they have none? Decision: only a funded crypto-native client persona is supported; the onramp seam exists and says so. Question for the human: is that acceptable for the Whitechain "payer flow" judges?
8. Anon-RPC bootstrap latency (tor-js, demo gateway capacity) may exceed 10 s. The pay flow never waits on it, but the dashboard "verified" badge appears late. Is a pre-recorded fallback clip allowed as a backup in the demo video if the live gateway is down?
9. Fee model: is 30 bps (visible to the payer as "Paid fee 0.30%") acceptable to the demo story, versus 0 with the business model stated only in README?
10. Single point of failure: the relayer key sits in env. For a hackathon this is fine; the README says production uses a KMS/HSM and the budget cap bounds the loss.
11. Disk: if the VM volume is lost, DB is lost; paid status is recoverable from chain, drafts and notes are not. Acceptable for a demo?

## Next implementation step

Ship the vertical slice in this order before any UI polish: `contracts/src/PaidSettlement.sol` with a Foundry test that settles a mock 3009 token, the shared `settle-nonce.ts` golden vector, and a deploy to 1874 with `forge verify-contract`, while the three spikes run alongside.

---

## Build plan (2-3 people, 36 hours)

```
 Owner A  chain/relayer     h0-2 spikes 1,4  h2-8 contract+deploy+verify  h8-16 pay intake + relayer loop + guard + crash tests  h16-22 agent-pay + fund-client + README Whitechain section
 Owner B  app/UI            h0-3 Next scaffold, drizzle schema, session, shell  h3-14 invoices (voice record, review, send), pay page  h14-24 dashboard, today page UI, polish  h24-30 demo script/video
 Owner C  AI + Anon-RPC     h0-3 spikes 2,3,5  h3-10 ZeroGClient + draftFromVoice  h10-16 chain-reader + meter + badge  h16-24 collections plan/reply/approve  h24-30 README 0G + Anon sections
 Everyone h30-36: seed data, deterministic demo run x3, WHITECHAIN_FEEDBACK.md, submission checklist, steady small commits (Whitechain asks for commit history)
```

Two-person variant: A+C merge Anon-RPC into A's lane; drop `agent-pay.ts` and the reply-classification screen first (`readReply` is the first cut), never the pay path or the receipts.

Demo script (3 min), each beat names its sponsor evidence:
1. Priya speaks "Invoice Acme, 3 logo drafts, $600" (0G chip with request id) -> review -> send. 40 s
2. Acme opens the link, clicks Pay once. No wallet words, no gas. Relayer tx appears; explorer link to USDT settlement. 50 s
3. Priya's dashboard flips to paid with the "verified privately" badge and the reads meter ("31 private / 0 direct; relayer infra direct, disclosed"). 30 s
4. `/today`: Hinglish firm reminder for another overdue invoice, paste a reply "Friday ko bhej dunga" -> promised date proposal -> approve. 40 s
5. One slide: relayer drain prevention; one sentence: what breaks without 0G; why onchain stablecoin vs bank rail. 20 s

README checklist (derived from sponsor rules): public repo; setup; architecture picture above; contract addresses + explorer links for `PaidSettlement` and the settled USDT tx; WHITECHAIN_FEEDBACK.md; "why onchain stablecoin settlement" line; Anon-RPC disclosure of exclusions; 0G one-sentence removal test; limitations (hidden wallet naive, demo personas, bootstrap read, relayer direct).

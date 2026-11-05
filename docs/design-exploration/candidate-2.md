# Paid, candidate 2: the chain is the ledger, the database is the notebook

One-line shape: **the contract is the only source of truth for "paid"; the database holds only what the freelancer authored; status is a pure function of the two, computed in the freelancer's browser over Anon-RPC.** There is no `paid` column anywhere, nothing to sync, and the relayer is a gas sponsor that cannot redirect, replay, or double-settle because the client's EIP-3009 nonce commits to `(invoiceId, payee)`.

```
 freelancer browser                 server (one Next.js process)              Whitechain Sepolia (1874)
 ┌──────────────────┐   DB rows     ┌────────────────────────┐                 ┌──────────────────────┐
 │ Today / Invoices │◄──────────────│ repo (only DB writer)  │                 │ PaidSettlement.sol   │
 │ deriveStatus()   │               │ ai/* → 0G (private)    │                 │ settlements[id]      │
 │ AnonRpcWorker ───┼──Tor──────────┼────────────────────────┼─ eth_call ─────►│ InvoiceSettled(...)  │
 └──────────────────┘               │ relayer.ensureSettled ─┼─ direct, disclosed ─►│  ▲ receiveWithAuth │
 client browser                     └────────────────────────┘                 │  │ USDT 0xcedf…55a7   │
 ┌──────────────────┐  POST /api/settle {sig}  ▲                               └──┼───────────────────┘
 │ hidden wallet    │──────────────────────────┘                                  │ payer's signature
 │ signTypedData    │────────────────────────────────────────────────────────────┘ (nonce = H(invoiceId, payee))
 └──────────────────┘
```

## Problem

Three sponsor rubrics pull in different directions. 0G wants AI in the main loop with request IDs and a reason to return tomorrow. EF wants every user read anonymized by default and the share disclosed. Whitechain wants a payer who signs once with no gas, a verified contract of our own settling official USDT, and a one-slide answer to "who can drain the relayer". All of it must be buildable in 36 hours by 1 to 5 people and demo in under 3 minutes with honest fallbacks. The non-obvious part is where payment truth lives. A database row that says `paid` must be kept in step with a chain event by a relayer that can crash between broadcast and write. Every design that stores payment twice inherits that race. This candidate stores it once, on chain, and treats the relayer's own bookkeeping as private operational state rather than invoice state. Constraints honored from grounding: secrets server-side only; EIP-712 domain for USDT hardcoded (`eip712Domain()` reverts); private-mode 0G returns 503 with no silent fallback; iAI sign-in only on localhost ports; Anon-RPC bootstrap is slow and its first specifier read is not anonymized.

## Usage (caller's view)

### README quickstart

```
pnpm i && cp .env.example .env            # OG_API_KEY, RELAYER_PRIVATE_KEY, SETTLEMENT_ADDRESS, FREELANCER_PAYEE
forge script contracts/script/Deploy.s.sol --rpc-url $RPC_1874 --broadcast --verify   # once
pnpm dev                                   # http://localhost:3000  (iAI sign-in needs this port)
```

Freelancer: open `/today`, press record, say "Invoice Acme, three logo drafts, six hundred dollars", review the draft, press Send, copy the link. Client: open the link, press Pay. Nothing else. Tomorrow: open `/today`, approve the reminders the agent drafted overnight, paste any client reply.

### Call site 1: freelancer turns a voice note into a sent invoice

```ts
// src/app/(freelancer)/invoices/new/actions.ts   (server actions; the page calls these in order)
'use server'
import { transcribe, draftInvoice } from '@/ai'
import { repo } from '@/db/repo'

export async function draftFromVoice(audio: Blob): Promise<AiResult<InvoiceDraft>> {
  const t = await transcribe(audio, billing())                 // AiResult<string>
  if (t.kind !== 'ok') return t                                // honest: UI offers a text box instead
  return draftInvoice(t.value, { knownClients: await repo.clients() }, billing())
}
export async function draftFromText(text: string): Promise<AiResult<InvoiceDraft>> {
  return draftInvoice(text, { knownClients: await repo.clients() }, billing())
}
export async function saveAndSend(draft: InvoiceDraft, edits: InvoiceEdits): Promise<{ id: InvoiceId; payUrl: string }> {
  const rec = await repo.createDraft(applyEdits(draft, edits))   // id minted here, same bytes32 on chain later
  await repo.markSent(rec.id)                                   // lifecycle draft→sent; payUrl = /pay/<id>
  return { id: rec.id, payUrl: payUrlFor(rec.id) }
}
```

### Call site 2: client pays with zero visible crypto

```ts
// src/app/pay/[id]/PayButton.tsx   (browser)
const wallet = await HiddenWallet.load()                        // generates+persists a key on first visit; no UI
const auth = buildReceiveAuthorization(invoice, wallet.address, new Date())   // nonce = H(invoiceId, payee)
const signature = await wallet.signTypedData(receiveAuthorizationTypedData(auth))
const res = await settle({ invoiceId: invoice.id, payer: wallet.address, validAfter: auth.validAfter, validBefore: auth.validBefore, signature })
// res: {kind:'settled',txHash} | {kind:'pending',txHash} | {kind:'already_settled',txHash} | {kind:'rejected',reason}
// then: poll reader.settlementsOf([invoice.id]) over Anon-RPC until paidAt != 0, show explorer link
```

### Call site 3: collections agent, "who owes you today"

```ts
// src/app/(freelancer)/today/page.tsx   (browser does the join; server never reads chain here)
const records = await getInvoices()                              // DB, server action
const settlements = await reader.settlementsOf(records.map(r => r.id))   // ONE eth_call via Multicall3 over Tor
const rows = records.map(r => ({ r, status: deriveStatus(r, settlements.get(r.id) ?? null, now) }))
const brief = buildBrief(rows, now)                              // pure: owed, overdue[], promisesDue[], needsReminder[]
const drafts = await draftReminders(brief.needsReminder.map(x => ({ id: x.r.id, status: x.status })))  // server, 0G
// freelancer approves each draft → approveReminder(id, 'copied' | 'email') → repo.addNote(reminder_sent)
const interp = await readReply(invoiceId, pastedText)            // AiResult<ReplyInterpretation>, shown for confirm
await confirmReply(invoiceId, interp.value)                      // repo.addNote(promise | dispute)
```

## Shape

### Data structures first (`src/domain/*`, pure, no IO)

```ts
// src/domain/ids.ts
declare const brand: unique symbol
type Brand<T, B extends string> = T & { readonly [brand]: B }
export type InvoiceId   = Brand<`0x${string}`, 'InvoiceId'>   // bytes32. Same value in URL, DB PK, and contract key.
export type FreelancerId = Brand<string, 'FreelancerId'>
export type ClientId    = Brand<string, 'ClientId'>
export type OgRequestId = Brand<string, 'OgRequestId'>
export type TxHash      = Brand<`0x${string}`, 'TxHash'>
export type UsdtMinor   = Brand<bigint, 'UsdtMinor'>            // 6 decimals; never a number
export type IsoDate     = Brand<string, 'IsoDate'>
export function parseInvoiceId(s: string): InvoiceId { /* ^0x[0-9a-f]{64}$ else throw */ throw new Error('not implemented') }
export function newInvoiceId(): InvoiceId { /* 32 random bytes */ throw new Error('not implemented') }
export function usdt(amountUsd: string): UsdtMinor { /* "600.00" → 600_000_000n */ throw new Error('not implemented') }

// src/domain/invoice.ts
export type LineItem = { description: string; qty: number; unitUsd: string }
export type Lifecycle = 'draft' | 'sent' | 'void'               // the ONLY stored status. 'paid' is not a lifecycle.
export type InvoiceRecord = {
  id: InvoiceId; freelancerId: FreelancerId; client: ClientRef
  lines: LineItem[]; amount: UsdtMinor; payee: Address          // payee frozen at creation; part of the nonce
  issuedAt: IsoDate; dueAt: IsoDate; lifecycle: Lifecycle; sentAt?: IsoDate
  provenance: { transcript: Traced<string> | { kind: 'typed' }; draft: OgTrace }
  notes: CollectionsNote[]                                       // append-only
}
export type ClientRef = { id: ClientId; name: string; email?: string; lang: 'en' | 'hinglish' }

export type CollectionsNote =
  | { kind: 'reminder_sent'; at: IsoDate; tone: Tone; channel: 'copied' | 'email'; trace: OgTrace }
  | { kind: 'promise';       at: IsoDate; promisedFor: IsoDate; trace: OgTrace }
  | { kind: 'dispute';       at: IsoDate; reason: string; trace: OgTrace }

// src/domain/settlement.ts  (chain-side facts, parsed from RPC at the boundary)
export type Settlement = { payer: Address; payee: Address; amount: UsdtMinor; paidAt: IsoDate; txHash?: TxHash }

// src/domain/status.ts  (THE join)
export type Tone = 'heads_up' | 'polite' | 'firm' | 'final'
export type InvoiceStatus =
  | { kind: 'draft' }
  | { kind: 'void' }
  | { kind: 'paid';      settlement: Settlement }               // wins over every other fact
  | { kind: 'awaiting';  daysUntilDue: number }
  | { kind: 'promised';  promisedFor: IsoDate; daysLate: number }
  | { kind: 'overdue';   daysLate: number; tone: Tone; lastReminderAt?: IsoDate }
export function deriveStatus(r: InvoiceRecord, s: Settlement | null, now: Date): InvoiceStatus { throw new Error('not implemented') }
export const ESCALATION: ReadonlyArray<{ minDaysLate: number; tone: Tone; cooldownDays: number }> = [
  { minDaysLate: -3, tone: 'heads_up', cooldownDays: 3 },
  { minDaysLate: 1,  tone: 'polite',   cooldownDays: 4 },
  { minDaysLate: 7,  tone: 'firm',     cooldownDays: 7 },
  { minDaysLate: 21, tone: 'final',    cooldownDays: 14 },
]
export function needsReminder(status: InvoiceStatus, now: Date): boolean { throw new Error('not implemented') }
export function buildBrief(rows: Array<{ r: InvoiceRecord; status: InvoiceStatus }>, now: Date): Brief { throw new Error('not implemented') }
export type Brief = { owed: UsdtMinor; paidLast30d: UsdtMinor; overdue: Row[]; promisesDue: Row[]; needsReminder: Row[] }

// src/domain/og.ts
export type OgTrace = { requestId: OgRequestId; provider: string; model: string; trustMode: 'private'; teeVerified: boolean | 'unchecked'; at: IsoDate }
export type Traced<T> = { kind: 'ok'; value: T; trace: OgTrace }
export type AiResult<T> = Traced<T> | { kind: 'unavailable'; reason: 'no_private_provider' | 'rate_limited' | 'network' | 'bad_output' }
```

Invariants encoded in types, per **type-system-discipline**: `trustMode: 'private'` is a literal, so an `OgTrace` from a non-private call cannot exist. `Lifecycle` has no `paid`, so nobody can write it. `InvoiceStatus.paid` carries the `Settlement`, so a "paid" with no chain evidence is unrepresentable. `UsdtMinor` is a branded bigint, so a JS `number` never reaches the token. `InvoiceId` is the bytes32 itself, so there is no id-mapping table to drift.

### Invoice state machine

Stored lifecycle (DB, freelancer-owned, three states) and chain fact (contract-owned, one bit) compose into the derived status. `deriveStatus` is the only place the rules live, per **model-the-domain**.

```
stored lifecycle:   draft ──send──► sent ──void──► void          (repo is the only writer)
chain fact:         settlements[id].paidAt == 0  ──settle()──► != 0   (contract is the only writer; irreversible)

derived = f(lifecycle, chainFact, notes, now):
  chainFact.paidAt != 0            → paid            (regardless of lifecycle; a paid void is paid)
  lifecycle == draft               → draft
  lifecycle == void                → void
  latest note is promise, future   → promised
  now <= dueAt                     → awaiting
  else                             → overdue (tone from ESCALATION by daysLate, cooldown from last reminder_sent)
```

### Module map

```
paid/
  contracts/                         Foundry
    src/PaidSettlement.sol           ownerless settlement; see interface below
    test/PaidSettlement.t.sol        fork test on 1874 against real USDT; nonce vector shared with TS
    script/Deploy.s.sol              USDT=0xcedf…, TREASURY=relayer EOA, FEE_BPS=100
    vectors/nonce.json               (invoiceId, payee) → nonce; read by forge test AND vitest (one list, two checks)
  web/                               Next.js 15 app router, port 3000, one process
    src/domain/                      pure; imported by browser and server
      ids.ts invoice.ts settlement.ts status.ts og.ts
    src/ai/                          server only; the 0G boundary
      og.ts                          ogChatJson, ogTranscribe, trace capture, error mapping, Billing seam
      transcribe.ts draftInvoice.ts collections.ts
      prompts/draft-invoice.md prompts/reminder.md prompts/read-reply.md
    src/chain/
      contract.ts                    abi + address, generated from forge `out/` by scripts/gen-abi.ts
      reader.ts                      ChainReader interface + makeReader(publicClient, route)
      anonReader.ts                  browser default: AnonRpcWorker → viem transport
      directReader.ts                server only; the disclosed exception
      relayer.ts                     ensureSettled; the only code holding RELAYER_PRIVATE_KEY
    src/db/
      schema.ts                      drizzle+sqlite: freelancers, clients, invoices, notes, broadcasts
      repo.ts                        InvoiceRepo: the only module that writes invoices/notes
    src/wallet/hiddenWallet.ts       browser: LocalKeyWallet { load, address, signTypedData }; onramp seam
    src/app/
      (freelancer)/today/            brief + reminders + reply reader
      (freelancer)/invoices/new/     record → draft → review → send
      (freelancer)/invoices/[id]/    detail, TraceBadge, explorer link
      pay/[id]/                      client page; PayButton
      api/settle/route.ts            POST → relayer.ensureSettled (zod at the edge)
      api/invoices/route.ts          GET records for the signed-in freelancer
    src/components/TraceBadge.tsx AnonRpcStatus.tsx
  README.md WHITECHAIN_FEEDBACK.md
```

Call chain for a payment is three files: `PayButton.tsx` → `api/settle/route.ts` → `relayer.ts`. For a status: `today/page.tsx` → `anonReader.ts` → `status.ts`. Internals stay unimportable from pages by an ESLint `no-restricted-imports` rule on `src/ai/og.ts` and `src/chain/relayer.ts` outside their own folders and `src/app/api`.

### Solidity contract (deployable and verifiable on 1874, settles official USDT via EIP-3009)

```solidity
// contracts/src/PaidSettlement.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC3009 {
    function receiveWithAuthorization(address from, address to, uint256 value, uint256 validAfter,
        uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external;
    function transfer(address to, uint256 value) external returns (bool);
}

/// @notice Ownerless, permissionless invoice settlement for official Whitechain Sepolia USDT.
/// Anyone may call settle(); only the payer's EIP-3009 signature moves funds. The signature's
/// nonce commits to (invoiceId, payee) and its `to` is this contract, so a submitter can neither
/// redirect the money, replay the authorization, nor settle an invoice twice.
contract PaidSettlement {
    IERC3009 public immutable usdt;        // 0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7
    address  public immutable treasury;    // relayer EOA: fee funds gas
    uint16   public immutable feeBps;      // 100 = 1%; may be 0

    struct Settlement { address payer; address payee; uint128 amount; uint64 paidAt; }
    mapping(bytes32 invoiceId => Settlement) public settlements;

    event InvoiceSettled(bytes32 indexed invoiceId, address indexed payee, address indexed payer, uint256 amount, uint256 fee);
    error AlreadySettled(bytes32 invoiceId);
    error ZeroAmount();

    constructor(IERC3009 usdt_, address treasury_, uint16 feeBps_) { /* require feeBps_ <= 1000 */ }

    /// Same formula as src/domain/settlement.ts authorizationNonce; vectors/nonce.json pins both.
    function nonceFor(bytes32 invoiceId, address payee) public pure returns (bytes32) {
        return keccak256(abi.encode(invoiceId, payee));
    }

    function settle(bytes32 invoiceId, address payee, address payer, uint256 amount,
        uint256 validAfter, uint256 validBefore, uint8 v, bytes32 r, bytes32 s) external {
        if (settlements[invoiceId].paidAt != 0) revert AlreadySettled(invoiceId);
        if (amount == 0) revert ZeroAmount();
        settlements[invoiceId] = Settlement(payer, payee, uint128(amount), uint64(block.timestamp)); // effects first
        usdt.receiveWithAuthorization(payer, address(this), amount, validAfter, validBefore, nonceFor(invoiceId, payee), v, r, s);
        uint256 fee = amount * feeBps / 10_000;
        usdt.transfer(payee, amount - fee);
        if (fee > 0) usdt.transfer(treasury, fee);
        emit InvoiceSettled(invoiceId, payee, payer, amount, fee);
    }
}
```

Why `receiveWithAuthorization` and not `transferWithAuthorization`: EIP-3009 requires `msg.sender == to` for `receive…`, so the client's signature can only be consumed by this contract through `settle()`, never submitted straight to the token to park USDT in the contract with no settlement record. The token's own `authorizationState(payer, nonce)` is a second replay guard beneath ours. Verification: `forge verify-contract --chain-id 1874` with constructor args; which verifier flavor the Whitechain explorer speaks is an open question below, so day 1 verifies a hello-world first.

TS side of the same agreement:

```ts
// src/domain/settlement.ts
export const USDT = { address: '0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7',
  domain: { name: 'Tether USD', version: '1', chainId: 1874, verifyingContract: '0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7' } } as const
export type ReceiveAuthorization = { from: Address; to: Address; value: UsdtMinor; validAfter: bigint; validBefore: bigint; nonce: Hex }
export function authorizationNonce(invoiceId: InvoiceId, payee: Address): Hex { /* keccak256(abi.encode(bytes32,address)) */ throw new Error('not implemented') }
export function buildReceiveAuthorization(inv: Pick<InvoiceRecord, 'id' | 'amount' | 'payee'>, payer: Address, now: Date): ReceiveAuthorization {
  // to = SETTLEMENT_ADDRESS, validAfter = 0, validBefore = now + 1h, nonce = authorizationNonce(inv.id, inv.payee)
  throw new Error('not implemented')
}
export function receiveAuthorizationTypedData(a: ReceiveAuthorization) { /* primaryType 'ReceiveWithAuthorization', EIP-3009 types */ throw new Error('not implemented') }
```

Browser signs it, server recovers it, contract consumes it. One builder, per **laziness-protocol** (consolidate decisions).

### Relayer: `ensureSettled`, drain prevention on one slide

```ts
// src/chain/relayer.ts  (server only)
export type SettleRequest = { invoiceId: InvoiceId; payer: Address; validAfter: bigint; validBefore: bigint; signature: Hex }
export type SettleResult =
  | { kind: 'settled'; txHash: TxHash; paidAt: IsoDate }
  | { kind: 'pending'; txHash: TxHash }                       // broadcast, receipt not yet seen within 20s
  | { kind: 'already_settled'; txHash?: TxHash }
  | { kind: 'rejected'; reason: 'invoice_not_payable' | 'bad_signature' | 'authorization_used' | 'insufficient_usdt'
                              | 'simulation_failed' | 'relayer_paused' | 'payer_cooldown' }

const inflight = new Map<InvoiceId, Promise<SettleResult>>()   // per-process dedupe of concurrent calls

export function ensureSettled(req: SettleRequest): Promise<SettleResult> {
  // return inflight.get(id) ?? run(req) (set, then delete in finally)
  throw new Error('not implemented')
}
async function run(req: SettleRequest): Promise<SettleResult> {
  // 1 invoice = repo.get(req.invoiceId); lifecycle must be 'sent' else rejected(invoice_not_payable)
  // 2 if directReader.settlementsOf([id]).paidAt != 0 → already_settled (txHash from InvoiceSettled log if cheap)
  // 3 row = broadcasts.get(id)
  //     if row: sendRawTransaction(row.rawTx)        // same bytes → same hash; node dedupes
  //        'already known' | accepted → waitForReceipt → settled | pending
  //        'nonce too low' | receipt.status == reverted → broadcasts.delete(id); fall through to 4
  // 4 guards: relayer WBT balance >= FLOOR else rejected(relayer_paused);  cooldown: same payer within 60s → rejected(payer_cooldown)
  // 5 auth = buildReceiveAuthorization(invoice, req.payer, now) with req.validAfter/validBefore; recoverTypedDataAddress == req.payer else bad_signature
  // 6 simulateContract(settle, args) → map revert: AlreadySettled → already_settled; token "authorization used" → authorization_used;
  //     transfer amount exceeds balance → insufficient_usdt; anything else → simulation_failed. NOTHING is broadcast unless this passes.
  // 7 rawTx = signTransaction(prepared); txHash = keccak(rawTx); broadcasts.insert({ id, rawTx, txHash, at })  // PK insert = CAS across processes
  // 8 sendRawTransaction(rawTx); waitForReceipt(20s) → settled | pending
  throw new Error('not implemented')
}
```

The slide: **"Our relayer only broadcasts a `settle()` it has already simulated to succeed, and `settle()` only succeeds by moving a real payer's USDT to a real invoice's freelancer. The only way to spend our WBT is to pay someone. On top: one successful tx per invoice forever (contract), one in-flight tx per invoice (write-ahead row), a 60s per-payer cooldown, and a WBT floor that pauses the relayer."** How it gets WBT: the faucet (0.5/day per GitHub account; each teammate claims day 1) at ~150k gas per settle covers thousands of demo payments; on mainnet the 1% `feeBps` lands USDT in `treasury` and that buys WBT. Residual griefing: a payer who moves their USDT away between our simulation and inclusion costs us one reverted tx's gas and costs them a tx of their own; the cooldown bounds the rate.

### Idempotency story for settlement

Four independent layers, innermost first. Each alone prevents a double payment; the outer ones only save gas and give a clean answer.

| layer | mechanism | what it stops |
|---|---|---|
| token | `authorizationState(payer, nonce)` | the same signature consumed twice |
| contract | `settlements[id].paidAt != 0 → AlreadySettled` | two different payers, or two signatures, for one invoice |
| relayer | chain pre-check, `inflight` map, `broadcasts` write-ahead row with the raw tx | duplicate broadcasts; reconciles after a crash |
| client | button disabled after first click; page polls chain, not the response | the response being lost on the wire |

Crash matrix for `run()`, per **make-operations-idempotent** (every step derives from current state, never from what the last run intended):

| crashed after | next call sees | converges by |
|---|---|---|
| 1 to 6 | no row, chain unsettled | fresh path; nothing was sent |
| 7 (row written, not sent) | row present | resends the same raw tx; same hash; harmless if already in the mempool |
| 8 (sent, no receipt) | row present | resends (node says already known), polls receipt |
| mined, response lost | chain settled | `already_settled` with tx hash from the log |
| relayer nonce moved on (another invoice settled meanwhile) | row present, resend fails nonce-too-low | row deleted, fresh path; simulation then returns `AlreadySettled` if the old tx actually mined |

"Crash between submit and DB write" is not a row in this matrix because there is no DB write for payment. The `broadcasts` table is the relayer's private journal; `deriveStatus` never reads it, and the UI never shows it as truth. The explorer link the client sees comes from the response, then from the `InvoiceSettled` log once the page's Anon-RPC poll confirms it.

### Anon-RPC read path

```ts
// src/chain/reader.ts
export type Route = 'anon' | 'direct'
export interface ChainReader {
  readonly route: Route
  readonly stats: { reads: number }                                     // feeds the AnonRpcStatus chip and README share table
  settlementsOf(ids: InvoiceId[]): Promise<Map<InvoiceId, Settlement | null>>   // viem multicall → Multicall3 (deployed on 1874) → one eth_call
  settlementEvents(payee: Address, fromBlock: bigint): Promise<Array<Settlement & { invoiceId: InvoiceId; txHash: TxHash }>>  // eth_getLogs, payee indexed
  usdtBalance(a: Address): Promise<UsdtMinor>
}
export function makeReader(client: PublicClient, route: Route): ChainReader { throw new Error('not implemented') }

// src/chain/anonReader.ts  (browser; the default)
export type AnonStatus = { kind: 'bootstrapping'; since: Date } | { kind: 'ready' } | { kind: 'failed'; error: string }
export async function startAnonReader(onStatus: (s: AnonStatus) => void): Promise<ChainReader> {
  // const worker = new AnonRpcWorker({ address: TOR_JS_SPECIFIER, config: { gateways: GATEWAYS }, preExisting: { rpcProvider: mainnetBootstrapProvider } })
  // await bootstrap; onStatus('ready')
  // transport = http(RPC_1874, { fetchFn: worker.fetch })        // if viem rejects fetchFn: custom({ request: r => worker.fetch(RPC_1874, jsonrpc(r)) })
  // return makeReader(createPublicClient({ chain: whitechainSepolia, transport }), 'anon')
  throw new Error('not implemented')
}
```

Policy. The worker starts in the root layout on first paint, so Tor is usually ready by the time the freelancer finishes recording. Every page renders its DB-backed content immediately and overlays chain facts when the reader resolves. `AnonRpcStatus` shows bootstrapping / ready / failed and the read count. There is no in-app "use direct RPC" toggle; `NEXT_PUBLIC_RPC_ROUTE=direct` exists for development only and is disclosed. If the worker fails, the dashboard shows "chain status unavailable via Tor" rather than silently going direct, which is the honest fallback the 0G and EF rubrics both reward.

Share of traffic, as the README table will state it: every user-originated read (freelancer dashboard, invoice detail, client balance, post-payment confirmation) is anonymized. Direct traffic is exactly the relayer's pre-check, simulation, broadcast and receipt polling, plus the first specifier read that Anon-RPC itself makes on mainnet. Nothing else touches an RPC. Moving status derivation into the browser is what makes the share this high: the server has no reason to read the chain outside the relayer.

### 0G call shapes with request_id capture

```ts
// src/ai/og.ts  (server only)
const OG = 'https://router-api.0g.ai/v1'
type PrivateModel = '0gm-1.0-35b-a3b' | 'glm-5.3'               // private-capable only; Qwen omni is TeeTLS and excluded by the type
export type Billing = { kind: 'team' } | { kind: 'user_0g'; token: string }   // iAI seam; header value chosen here, once
function headers(b: Billing): Record<string, string> { /* Authorization Bearer (team key | user token), 'X-0G-Provider-Trust-Mode': 'private' */ throw new Error('not implemented') }
function parseTrace(body: unknown, model: string): OgTrace { /* body.x_0g_trace.{request_id, provider, tee_verified} → OgTrace; 'unchecked' when absent */ throw new Error('not implemented') }
function mapFailure(res: Response): AiResult<never> { /* 503 no_provider_for_trust_mode → no_private_provider; 429 → rate_limited */ throw new Error('not implemented') }

export async function ogChatJson<T>(schema: ZodType<T>, model: PrivateModel, messages: Msg[], b: Billing): Promise<AiResult<T>> {
  // POST /chat/completions { model, messages, response_format: { type: 'json_object' }, temperature: 0.2 }
  // ok → trace = parseTrace(body); value = schema.safeParse(JSON.parse(choices[0].message.content)) else bad_output
  throw new Error('not implemented')
}
export async function ogTranscribe(audio: Blob, b: Billing): Promise<AiResult<string>> {
  // POST /audio/transcriptions?verify_tee=true  multipart { file: audio, model: 'whisper-large-v3' }  with private header
  throw new Error('not implemented')
}

// src/ai/draftInvoice.ts
export const InvoiceDraftSchema = z.object({ clientName: z.string(), lines: z.array(LineItemSchema).min(1), totalUsd: z.string(), dueInDays: z.number().int().min(1).max(90), notes: z.string().optional() })
export function draftInvoice(text: string, ctx: { knownClients: ClientRef[] }, b: Billing): Promise<AiResult<InvoiceDraft>> { throw new Error('not implemented') }

// src/ai/collections.ts
export const ReminderDraftSchema = z.object({ subject: z.string(), body: z.string(), lang: z.enum(['en', 'hinglish']) })
export function draftReminder(inv: InvoiceRecord, status: Extract<InvoiceStatus, { kind: 'overdue' | 'promised' }>, b: Billing): Promise<AiResult<ReminderDraft>> { throw new Error('not implemented') }
export const ReplyInterpretationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('promise'), promisedFor: z.string().date(), quote: z.string() }),
  z.object({ kind: z.literal('dispute'), reason: z.string(), quote: z.string() }),
  z.object({ kind: z.literal('claims_paid'), quote: z.string() }),     // UI answers with the chain: "no settlement seen for this invoice"
  z.object({ kind: z.literal('unclear') }),
])
export function readReply(inv: InvoiceRecord, replyText: string, b: Billing): Promise<AiResult<ReplyInterpretation>> { throw new Error('not implemented') }
```

Every artifact the AI produces is stored with its `OgTrace` (`invoices.provenance`, `notes[].trace`), and `TraceBadge` renders `request_id`, provider and `tee_verified` next to it. The judge can click any invoice and see the receipt for the voice transcript and the draft. The one-sentence answer for the rubric: "Remove 0G and no invoice can be drafted from a voice note, no reminder gets written, and no client reply gets read; what is left is a form and a pay link." Reason to return tomorrow: `/today` is recomputed from chain and notes each morning, and the reminders it drafted are waiting for approval.

### Tech stack

Next.js 15 (app router, server actions, route handlers) on port 3000 in one process, so the iAI sign-in works on localhost and Railway hosts the same image for the live link with a volume for SQLite. TypeScript strict, zod at the three boundaries (HTTP, 0G responses, RPC decode), viem 2 on both sides, no wagmi because there is no wallet picker. Drizzle + better-sqlite3. `anon-rpc` npm package in the browser. 0G through plain `fetch`. Foundry for the contract, with `vectors/nonce.json` checked by both `forge test` and vitest. Vitest covers `deriveStatus`, `buildBrief`, `needsReminder`, and the authorization builder; a forge fork test settles a real signed authorization against the real USDT on 1874.

Sequencing for the 36 hours, per **foundational-thinking** (scaffold first): hour 0 to 3 verifies externals in parallel (explorer verifier flavor with a hello contract, `receiveWithAuthorization` caller check on TetherTokenV2, 0G private transcription returning `x_0g_trace`, Anon-RPC bootstrap on venue Wi-Fi, faucet claims, WBT to USDT swap for the demo client). Hour 3 to 8: domain types, contract, deploy, verify. Hour 8 to 16: relayer and pay page end to end with a real USDT settlement, explorer link into the README the moment it exists. Hour 16 to 28: voice to draft to send, `/today`, reminders, reply reader. Hour 28 to 34: Anon-RPC status UX, TraceBadge polish, iAI seam. Last two hours: video, README, feedback file.

## Synthesis decision

*(left empty for arena)*

## Tradeoffs accepted

- We accept that the freelancer's dashboard cannot show "paid" until the browser's Tor circuit is up, in exchange for every user read being anonymized and for never storing payment state twice. The worker starts on first paint and the DB-backed UI renders instantly, so the gap is a status chip, not a blank screen.
- We accept a direct, non-anonymized RPC path for the relayer, in exchange for a settlement that is simulated before it is paid for. This is the disclosed exception the EF rubric allows, and it is the server's traffic, not the user's.
- We accept an ownerless contract with no pause, no upgrade and no rescue, in exchange for a one-sentence trust story. If the Tether implementation's `receiveWithAuthorization` turns out not to enforce `msg.sender == to`, the fallback is `transferWithAuthorization` plus an owner-gated sweep, and that is a known downgrade.
- We accept a 1% on-chain fee in the demo, in exchange for a concrete answer to "how does the business pay gas". The freelancer sees "you receive $594" at send time; `feeBps` can be deployed as 0.
- We accept a single-tenant freelancer for the hackathon (one seeded `FreelancerId`, payee from env), in exchange for no auth system. The 0G sign-in is a billing and credit-balance seam, not an identity system.
- We accept that the client's hidden wallet is a browser-local key, in exchange for zero visible crypto steps on a chain with no embedded-wallet provider. The demo client is pre-funded; the onramp is a seam behind `HiddenWallet`, not a feature.
- We accept that a reorg would make a paid invoice read as unpaid again, in exchange for never caching chain state. That is the honest reading.
- We accept Hinglish or English chosen per client, not per message, so the reminder prompt has one fewer knob.

## Alternatives considered

- **Database as source of truth, chain as evidence.** The relayer writes `paid` after the receipt; a reconciler job repairs drift from `InvoiceSettled` logs. Exposes to callers a status that may lag or lie, needs a cron, a reconciliation table, and an answer for "crash between receipt and write". It hides nothing the chain does not already hold. Lost on interface depth: two writers for one fact.
- **Server does all chain reads and serves status over its API.** Simplest UI, and the collections job could run headless. Lost because it moves the user's reads to the server, so Anon-RPC would anonymize nothing the user cares about and the EF share would be a rounding error. It also makes the server a second cache of chain truth.
- **Freelancer registers each invoice on chain (`createInvoice(id, payee, amount)`), then anyone pays it.** Cleanest contract semantics and the payee lives in storage rather than in a nonce formula. Lost because it costs the freelancer a gas tx per invoice, which contradicts "nobody notices", and adds a third state the UI must wait on.
- **Permit (EIP-2612) plus `transferFrom` instead of EIP-3009.** Two token calls, an allowance that lingers, and a signature that does not bind to a destination. EIP-3009 `receive…` binds `to`, and our nonce binds the rest.
- **Account abstraction (EntryPoint 0.7 is deployed on 1874) with a paymaster.** Richer, but the thirdweb bundler rejects 1874 and no verified bundler exists in grounding. A relayer EOA plus EIP-3009 is 300 lines less and demonstrably works (grounding tx `0x23c2…9d376`).
- **A queue or worker for settlement and reminders.** Lost under **laziness-protocol**: one process, an in-memory inflight map, and a PK insert give the same guarantees for one relayer; `/today` recomputes on open instead of a nightly cron.

## Implementation reconciliation

*(empty until Phase D)*

## Open questions and risks

- Does TetherTokenV2 on 1874 enforce `msg.sender == to` in `receiveWithAuthorization`? If not, do we accept the downgrade to `transferWithAuthorization` plus an owner sweep, or do we add payee registration?
- Which verifier does the Whitechain explorer speak, Blockscout or Etherscan-style, and does it accept constructor args from `forge verify-contract`?
- Does the 0G transcription endpoint honor `X-0G-Provider-Trust-Mode: private` and return `x_0g_trace`? If it only serves one private provider and it is down at demo time, is the typed-text fallback acceptable to the team for the video, or do we pre-record a second take with voice?
- Does viem's `http()` accept `fetchFn` on the installed version, or do we go straight to `custom()`?
- Does the venue network let tor-js bootstrap in under 60 seconds, and do Ankr's exits accept Tor? If not, is `rpc.testnet.whitechain.io` the primary for the anonymized path?
- Fee at 1% or 0 for the demo? A fee makes the "how we pay gas" slide concrete but adds one number to explain.
- Should "Send" also email the client (adds Resend and a domain) or stay copy-link only for the demo?
- Do we want `claims_paid` replies to trigger an automatic chain check in the UI ("no settlement seen for this invoice")? It is a strong demo beat but one more branch on the reply screen.
- What exactly does the 0G Privy app ID hand us at the event: a JWT the router accepts as Bearer, or a session the SDK must mint? The `Billing` seam assumes a token.
- Multi-tenant now (Privy user id as `FreelancerId`) or after the hackathon? The types allow it; the auth does not exist.

## Next implementation step

Write `src/domain/*` and `contracts/src/PaidSettlement.sol` together with `vectors/nonce.json`, and get `forge test --fork-url $RPC_1874` to settle one real signed `ReceiveWithAuthorization` against `0xcedf…55a7`, because every other module trusts that this agreement holds.

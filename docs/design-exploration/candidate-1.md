# Paid: candidate 1, "the chain is the ledger, the log is the memory"

One Node process (Hono API + Vite SPA + SQLite + an in-process relayer actor), one immutable Solidity contract, one pure `domain/` folder imported by both browser and server. Four ideas carry the design:

1. **Invoice state is a pure fold over an append-only event log**, never a mutable `status` column. Each actor owns its own facts: the freelancer and the agent append invoice events, the relayer owns settlement rows, the chain owns "paid". Status is derived at the read boundary.
2. **The EIP-3009 nonce is derived from the invoice terms**, `nonce = keccak256(chainid, contract, invoiceRef, payee, gross)`. The payer's one signature therefore commits to who gets paid and how much, and the token itself refuses a replay. Idempotency starts on chain.
3. **The browser is the only chain reader; the server is the only chain writer.** Every user-originated read goes through Anon-RPC. The server never reads the chain on a user's behalf, so "share of traffic through Anon-RPC" is 100% of user reads by construction, and a meter proves it in the UI.
4. **No AI value can enter the log without a 0G receipt.** `Attested<T>` pairs every model output with its `request_id`; event types that carry AI output require it, so the compiler enforces "request IDs in the main flow".

---

## Problem

An Indian freelancer billing foreign clients loses days and 3 to 5% to SWIFT/PayPal, and loses more to awkward chasing. Paid turns a voice note into an invoice, lets a foreign client pay USDT on Whitechain Sepolia with one signature and no gas, and runs a collections agent that tells the freelancer every morning who owes them and drafts the nudge. Three sponsor rule sets constrain the shape and pull against each other. 0G wants the AI to be the product, run in private mode, with request IDs visible. EF wants RPC reads anonymized by default and measured. Whitechain wants a verified contract of our own that settles official USDT `0xcedf...55a7` with zero payer crypto steps, plus a credible answer to "what stops someone draining the relayer". Hard constraints from grounding: no bundler or embedded-wallet provider is verified on 1874, so gasless must come from EIP-3009 itself; `eip712Domain()` reverts, so the domain is hardcoded; private transcription has one provider and may 503 with no silent fallback; iAI sign-in only works on localhost 3000/3001/5173; settlement must survive double-click, relayer retry, and a crash between broadcast and DB write. Greenfield, ~36 hours, 3-minute demo.

## Usage (caller's view)

### README excerpt (what a judge reads)

> **Paid** gets Indian freelancers paid by foreign clients in minutes, not weeks. Speak an invoice, send a link, and Paid's private AI chases the money for you.
>
> - **Why onchain stablecoin settlement:** a $600 SWIFT or PayPal payment costs the freelancer $20 to $40 and 2 to 5 days; USDT on Whitechain settles in seconds for a 0.5% fee (capped at $2) that also pays the gas, and the receipt is a public, verifiable transaction instead of a bank PDF.
> - **What breaks if 0G is removed:** nothing gets drafted, nothing gets chased. Voice-to-invoice, reminder drafting, and reading client replies all run on 0G Private Computer, and private mode is the reason a freelancer can hand an AI their client list, rates, and email threads at all.
> - **Anon-RPC:** every chain read the app makes from your browser goes through Tor. The footer meter shows the count.
> - **Run:** `pnpm i && cp .env.example .env && pnpm dev` (localhost:5173, iAI sign-in works) or `pnpm build && pnpm start` (localhost:3000).

### Demo path (each party on screen)

```
Freelancer (localhost:5173, signed in with 0G)        Client (incognito, /pay/<token>)
 1. hold mic: "Invoice Acme, 3 logo drafts, $600"
 2. draft appears + chip "Private on 0G · req 7f3a.."
 3. edit due date, Send -> copy link  ─────────────────> 4. sees invoice, "Pay $600.00"
                                                         5. email login (embedded wallet), one tap
                                                         6. "Paid. Receipt" (explorer link)
 7. Today view: Acme moves to Paid (verified via Tor)
 8. Globex is 6 days late: agent drafted a firmer Hinglish nudge -> Approve -> WhatsApp opens
 9. paste Globex reply "will pay friday" -> agent reads it -> "Promised Fri 13 Nov" -> Confirm
10. footer: "Anon-RPC: 41/41 reads via Tor"; /proof lists every 0G request_id
```

### Freelancer call sites (`src/web/routes/*.tsx`)

```ts
import { api } from '../api';

// Record.tsx: voice to draft. One call hides transcribe + extract + persist.
const result = await api.invoices.fromVoice(audioBlob);
switch (result.kind) {
  case 'drafted':        navigate(`/invoices/${result.invoice.ref}`); break; // result.receipts: ZgReceipt[]
  case 'private_ai_unavailable': showTypedFallback(result.message); break;   // honest: no non-private fallback
  case 'unreadable':     showRetry(result.transcript); break;
}

// InvoiceEdit.tsx: edit then send. After send, terms are frozen (they are inside the nonce).
await api.invoices.edit(ref, { lineItems, clientEmail, dueDate });
const { payLink } = await api.invoices.send(ref);   // payLink = https://.../pay/<PayToken>

// Dashboard.tsx: server facts merged with chain facts read over Tor, in the browser.
const reader = await getChainReader();               // boots Anon-RPC once per tab
const [book, onchain] = await Promise.all([api.book(), reader.settlementsTo(me.payoutAddress)]);
const view = mergeBook(book, onchain, today());      // pure, from domain/
// view.totals: { paid, pending, overdue } in UsdtMicros; view.rows[i].paidProof: 'chain' | 'relayer' | null
```

### Client call sites (`src/web/routes/Pay.tsx`)

```ts
const inv = await api.pay.load(token);               // PayView: terms the payer sees, no freelancer internals
const wallet = await payerWallet();                   // embedded wallet; address never shown
const auth = buildReceiveAuth({                        // pure, shared with server (domain/settlement.ts)
  ref: inv.ref, payee: inv.payee, gross: inv.gross, payer: wallet.address, now: Date.now(),
});
const signature = await wallet.signTypedData(toTypedData(auth));
const s = await api.pay.submit(token, { payer: wallet.address, validBefore: auth.validBefore, signature });
// Same token + double click => same SettlementView. Body carries no amount and no payee:
// the server rebuilds the message from its own record and verifies the signature against it.
renderSettlement(s);                                   // 'queued' | 'broadcast' | 'confirmed' | 'refused'
reader.watchSettled(inv.ref, () => showBadge('Verified on-chain, privately'));
```

### Collections agent call sites (`src/web/routes/Today.tsx`)

```ts
const brief = await api.today();                      // Briefing, computed server-side
// brief.headline: Attested<string>  e.g. "₹1.4L is out. Acme promised today; Globex is 6 days late."
for (const item of brief.items) {
  switch (item.next.kind) {
    case 'remind':   renderDraft(item.next.draft);    // Attested<ReminderDraft>, tone from ladder
                     break;
    case 'wait':     renderWaiting(item.next.until, item.next.why); break; // promise not yet due
    case 'paid':     renderThanks(item); break;
  }
}
const { deepLink } = await api.reminders.approve(ref, item.next.draft.value.id, 'whatsapp');
window.open(deepLink);                                // wa.me/... or mailto:..., sent from the freelancer's own account
const reading = await api.replies.read(ref, pastedText); // Attested<ReplyReading>
await api.replies.confirm(ref, reading.value);        // only a confirmed reading becomes an event
```

### Server call sites (internal)

```ts
// routes.ts
const intent = parseSubmit(await c.req.json());        // boundary: zod -> SubmitIntent
return c.json(await relayer.submit(token, intent));    // idempotent; never throws for business refusals

// ai.ts
const draft = await zg.chat(TASKS.draftInvoice, { transcript: t.value }); // Attested<InvoiceDraft>
```

## Shape

### Data first: the access patterns

| Access | Structure that answers it |
|---|---|
| Today view: all open invoices of one freelancer, ranked by urgency | `invoice_events` by `freelancer_id`, folded with `deriveInvoice`; ranking is a pure sort |
| Has this invoice been paid? | chain `settled(ref)` / `InvoiceSettled` log (truth); `settlements` row (relayer's receipt) |
| Double click / retry on pay | `settlements` PK `ref` + on-chain `settled[ref]` + USDT `authorizationState(payer, nonce)` |
| Crash between broadcast and DB write | `settlements.raw_tx` + `tx_hash` written before broadcast; boot reconcile |
| Proof of private inference | `zg_receipts` keyed by `request_id`, referenced from events |
| Dashboard totals | browser merge of `api.book()` and Tor-read `InvoiceSettled(payee)` logs |

### Types (`src/domain/ids.ts`, `money.ts`, `invoice.ts`)

```ts
declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type Hex32        = Brand<`0x${string}`, 'Hex32'>;
export type InvoiceRef   = Brand<Hex32, 'InvoiceRef'>;     // random bytes32; public, appears on chain
export type PayToken     = Brand<string, 'PayToken'>;      // 128-bit secret in the pay link; never on chain
export type FreelancerId = Brand<string, 'FreelancerId'>;  // 0G Privy DID
export type Address      = Brand<`0x${string}`, 'Address'>; // checksummed
export type TxHash       = Brand<Hex32, 'TxHash'>;
export type Signature    = Brand<`0x${string}`, 'Signature'>;
export type UsdtMicros   = Brand<bigint, 'UsdtMicros'>;    // 6 decimals; never a float
export type IsoDay       = Brand<string, 'IsoDay'>;        // YYYY-MM-DD in freelancer's TZ (Asia/Kolkata)
export type ZgRequestId  = Brand<string, 'ZgRequestId'>;
export type EventSeq     = Brand<number, 'EventSeq'>;

// Each is the only way to make the brand. Boundaries call these; inner code trusts the type.
export function parseInvoiceRef(x: unknown): InvoiceRef { throw new Error('not implemented'); }
export function parseUsd(text: string): UsdtMicros { throw new Error('not implemented'); } // "$600" -> 600_000000n
export function newInvoiceRef(): InvoiceRef { throw new Error('not implemented'); }       // crypto.getRandomValues
export function newPayToken(): PayToken { throw new Error('not implemented'); }
```

Two IDs on purpose. `InvoiceRef` is public because it is in the `InvoiceSettled` event. If the pay link used it, anyone reading the chain could open the pay page and see client name and line items. `PayToken` is the secret capability; `InvoiceRef` is the public handle.

### AI provenance (`src/domain/attested.ts`)

```ts
export type ZgReceipt = {
  requestId: ZgRequestId;           // x_0g_trace.request_id
  provider: string;                 // x_0g_trace.provider
  model: 'glm-5.3' | '0gm-1.0-35b-a3b' | 'whisper-large-v3';
  task: ZgTask;
  teeVerified: boolean | 'not_reported'; // x_0g_trace.tee_verified, when verify_tee honoured
  resKey: string | null;            // ZG-Res-Key header, for independent processResponse check
  billing: unknown;                 // x_0g_trace.billing, displayed raw on /proof
  at: string;
};
export type Attested<T> = { readonly value: T; readonly receipt: ZgReceipt };
export type ZgTask = 'transcribe' | 'draftInvoice' | 'draftReminder' | 'readReply' | 'briefing';
```

### Invoice: events, commands, derived status (`src/domain/invoice.ts`)

```ts
export type LineItem = { description: string; qty: number; unit: UsdtMicros };
export type InvoiceTerms = {
  clientName: string; clientContact: { email?: string; whatsapp?: string };
  lineItems: readonly LineItem[]; dueDay: IsoDay; note?: string;
};

export type InvoiceEvent =
  | { kind: 'drafted';  terms: InvoiceTerms; source: DraftSource }
  | { kind: 'edited';   terms: InvoiceTerms }
  | { kind: 'sent';     payee: Address; gross: UsdtMicros; payToken: PayToken } // terms frozen here
  | { kind: 'reminded'; tone: Tone; channel: 'whatsapp' | 'email'; body: string; draft: ZgRequestId }
  | { kind: 'replyRead'; reading: ReplyReading; receipt: ZgRequestId }          // freelancer-confirmed
  | { kind: 'voided';   reason: string };

export type DraftSource =
  | { kind: 'voice'; transcript: Attested<string>; extraction: ZgReceipt }
  | { kind: 'typed' };

export type ReplyReading =
  | { kind: 'promise';  day: IsoDay; quote: string }
  | { kind: 'dispute';  reason: string; quote: string }
  | { kind: 'claimsPaid'; quote: string }   // checked against chain before UI says anything
  | { kind: 'unclear';  summary: string };

export type Command =
  | { kind: 'edit'; terms: InvoiceTerms }
  | { kind: 'send'; payee: Address }
  | { kind: 'recordReminder'; tone: Tone; channel: 'whatsapp' | 'email'; body: string; draft: ZgRequestId }
  | { kind: 'confirmReading'; reading: ReplyReading; receipt: ZgRequestId }
  | { kind: 'void'; reason: string };

export type Refusal =
  | { kind: 'frozen'; why: 'terms are signed into the payment nonce once sent' }
  | { kind: 'not_sent' } | { kind: 'already_paid' } | { kind: 'voided' } | { kind: 'empty_invoice' };

/** Pure decider. The only place that knows which command is legal in which state. */
export function decide(state: InvoiceState, cmd: Command): { ok: true; events: InvoiceEvent[] } | { ok: false; refusal: Refusal } {
  throw new Error('not implemented');
}

/** Pure fold over this invoice's own log. Knows nothing about payment. */
export function fold(events: readonly InvoiceEvent[]): InvoiceState { throw new Error('not implemented'); }

export type InvoiceState =
  | { phase: 'draft'; terms: InvoiceTerms }
  | { phase: 'sent'; terms: InvoiceTerms; payee: Address; gross: UsdtMicros; payToken: PayToken;
      reminders: readonly { tone: Tone; at: string }[]; latestReading: ReplyReading | null }
  | { phase: 'voided'; terms: InvoiceTerms };

/** Merge at the read boundary: invoice log + relayer row + (optional) chain fact + today. */
export function deriveStatus(s: InvoiceState, settlement: SettlementView | null, chain: ChainSettlement | null, today: IsoDay): InvoiceStatus {
  // chain wins over relayer row; relayer row wins over log; overdue is computed, never stored
  throw new Error('not implemented');
}

export type InvoiceStatus =
  | { s: 'draft' }
  | { s: 'open'; dueDay: IsoDay; daysLate: number; promise: { day: IsoDay; broken: boolean } | null; dispute: string | null }
  | { s: 'paying'; tx: TxHash | null }
  | { s: 'paid'; tx: TxHash; net: UsdtMicros; proof: 'chain' | 'relayer' }
  | { s: 'voided' };
```

State machine (the `paying`/`paid` edges come from the settlement side, not from invoice events):

```
            edit (loop)
   ┌────────┐ send  ┌──────┐  relayer queued  ┌────────┐ receipt / InvoiceSettled ┌──────┐
   │ draft  │──────>│ open │─────────────────>│ paying │─────────────────────────>│ paid │
   └───┬────┘       └──┬───┘<─────────────────└────────┘  refused / expired       └──────┘
       │ void          │ void       (open carries derived daysLate, promise, dispute)
       v               v
   ┌────────┐      ┌────────┐
   │ voided │      │ voided │   (void after paid: refused)
   └────────┘      └────────┘
```

### Collections policy (`src/domain/collections.ts`, pure)

```ts
export type Tone = 'friendly' | 'nudge' | 'firm' | 'final';
export type NextAction =
  | { kind: 'remind'; tone: Tone; draft: Attested<ReminderDraft> }
  | { kind: 'wait'; until: IsoDay; why: 'not_due' | 'promised' | 'just_reminded' }
  | { kind: 'paid' };
export type ReminderDraft = { id: string; language: 'en' | 'hinglish'; subject?: string; body: string };

/** Tone ladder is a table, not branches. daysLate buckets x broken promises -> tone. */
export const TONE_LADDER: readonly { minDaysLate: number; tone: Tone }[] = [
  { minDaysLate: -2, tone: 'friendly' }, { minDaysLate: 3, tone: 'nudge' },
  { minDaysLate: 10, tone: 'firm' },     { minDaysLate: 21, tone: 'final' },
];
export function planNext(status: InvoiceStatus, state: InvoiceState, today: IsoDay): Omit<NextAction, 'draft'> | { kind: 'remind'; tone: Tone } {
  // broken promise bumps one rung; reminded < 48h ago => wait
  throw new Error('not implemented');
}
export function rank(items: readonly BriefItem[]): BriefItem[] { throw new Error('not implemented'); }
```

The AI drafts words; the table decides tone and timing. A judge can see that the agent is not a chat wrapper: it holds state across days, escalates on its own schedule, and its reading of a reply changes the invoice's future.

### Settlement (`src/domain/settlement.ts`, pure, shared browser + server)

```ts
export const USDT = '0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7' as Address;
export const USDT_DOMAIN = { name: 'Tether USD', version: '1', chainId: 1874, verifyingContract: USDT } as const; // eip712Domain() reverts
export const SETTLEMENT: Address = /* from deploy, baked at build */ '0x...' as Address;
export const SETTLEMENT_DEPLOY_BLOCK = 0n; // getLogs lower bound

export type ReceiveAuth = {
  ref: InvoiceRef; payee: Address; gross: UsdtMicros; payer: Address;
  validAfter: bigint; validBefore: bigint; nonce: Hex32;
};
/** nonce = keccak256(abi.encode(1874, SETTLEMENT, ref, payee, gross)); mirrors PaidSettlement.nonceFor. */
export function nonceFor(ref: InvoiceRef, payee: Address, gross: UsdtMicros): Hex32 { throw new Error('not implemented'); }
export function buildReceiveAuth(a: { ref: InvoiceRef; payee: Address; gross: UsdtMicros; payer: Address; now: number }): ReceiveAuth {
  // validAfter 0, validBefore now + 60 min; to = SETTLEMENT (receiveWithAuthorization requires msg.sender == to)
  throw new Error('not implemented');
}
export function toTypedData(a: ReceiveAuth) /* viem TypedDataDefinition, primaryType 'ReceiveWithAuthorization' */ { throw new Error('not implemented'); }
export function feeOf(gross: UsdtMicros): UsdtMicros { throw new Error('not implemented'); } // mirrors contract: min(gross*50/10000, 2 USDT)

export type SubmitIntent = { payer: Address; validBefore: bigint; signature: Signature };
export type SettlementView =
  | { state: 'queued' }
  | { state: 'broadcast'; tx: TxHash }
  | { state: 'confirmed'; tx: TxHash; block: bigint; net: UsdtMicros }
  | { state: 'refused'; reason: SettleRefusal; retryable: boolean };
export type SettleRefusal =
  | 'bad_signature' | 'insufficient_usdt' | 'simulation_reverted' | 'expired'
  | 'invoice_not_open' | 'relayer_paused' | 'rate_limited';
export type ChainSettlement = { ref: InvoiceRef; payee: Address; payer: Address; gross: UsdtMicros; fee: UsdtMicros; tx: TxHash; block: bigint };
```

The `ReceiveWithAuthorization` variant (not `transferWithAuthorization`) is load-bearing: USDT only accepts it from `msg.sender == to`, and `to` is our contract, so a mempool watcher cannot lift the signature and settle it some other way.

### Solidity (`contracts/src/PaidSettlement.sol`)

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IUSDT3009 {
    function receiveWithAuthorization(address from, address to, uint256 value, uint256 validAfter,
        uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external;
    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool);
}

/// No owner, no proxy, no pause, no withdraw. Holds funds only inside one settle() call.
/// Anyone may call settle(): our relayer is a convenience, not a privilege.
contract PaidSettlement {
    IUSDT3009 public immutable usdt;      // 0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7
    address   public immutable treasury;  // receives fees; fees buy WBT for the relayer
    uint16    public constant FEE_BPS = 50;          // 0.5%
    uint256   public constant FEE_CAP = 2_000000;    // 2 USDT

    mapping(bytes32 invoiceRef => bool) public settled;

    event InvoiceSettled(bytes32 indexed invoiceRef, address indexed payee, address indexed payer,
                         uint256 gross, uint256 fee);
    error AlreadySettled(bytes32 invoiceRef);
    error TransferFailed();

    constructor(IUSDT3009 usdt_, address treasury_) { usdt = usdt_; treasury = treasury_; }

    function nonceFor(bytes32 invoiceRef, address payee, uint256 gross) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), invoiceRef, payee, gross));
    }

    function settle(bytes32 invoiceRef, address payee, address payer, uint256 gross,
                    uint256 validAfter, uint256 validBefore, uint8 v, bytes32 r, bytes32 s) external {
        if (settled[invoiceRef]) revert AlreadySettled(invoiceRef);
        settled[invoiceRef] = true;                                    // effects before interactions
        usdt.receiveWithAuthorization(payer, address(this), gross, validAfter, validBefore,
                                      nonceFor(invoiceRef, payee, gross), v, r, s);
        uint256 fee = gross * FEE_BPS / 10_000; if (fee > FEE_CAP) fee = FEE_CAP;
        _safeTransfer(payee, gross - fee);
        if (fee != 0) _safeTransfer(treasury, fee);
        emit InvoiceSettled(invoiceRef, payee, payer, gross, fee);
    }

    function _safeTransfer(address to, uint256 amount) private {
        // low-level call; accept empty return data (USDT-family tokens historically return nothing)
        (bool ok, bytes memory ret) = address(usdt).call(abi.encodeWithSignature("transfer(address,uint256)", to, amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }
}
```

Deploy and verify: `forge script script/Deploy.s.sol --rpc-url $RPC_1874 --broadcast --verify --verifier blockscout --verifier-url $WHITECHAIN_EXPLORER_API` (verifier type to confirm at the event). Constructor args are two addresses, flat single file, no imports, so manual "flatten and paste" verification is a five-minute fallback. Test: `contracts/test/PaidSettlement.t.sol` forks 1874, signs a `ReceiveWithAuthorization` with a test key funded via `deal`, asserts payee net, treasury fee, `settled[ref]`, and that a second `settle` with the same or a re-signed auth reverts.

Why the payee is in the nonce: the contract recomputes the nonce from the `payee` and `gross` arguments. If a relayer (ours, compromised, or anyone) swaps the payee, the nonce changes, the USDT signature check fails, and the call reverts. The payer's single signature authorizes exactly "this amount to this freelancer for this invoice", without a second signature or a contract-level EIP-712 domain.

### Relayer (`src/server/relayer.ts`)

A single-writer actor. One EOA has one nonce sequence, so one shared writer is a real invariant and is serialized structurally (one in-process queue, concurrency 1), per separate-before-serializing-shared-state. Nothing else in the codebase touches the relayer key.

```ts
export type Relayer = {
  /** Idempotent by PayToken. Never throws for business refusals; returns SettlementView. */
  submit(token: PayToken, intent: SubmitIntent): Promise<SettlementView>;
  view(ref: InvoiceRef): SettlementView | null;
  /** Runs at boot and every 30 s. Converges every non-terminal row against chain truth. */
  reconcile(): Promise<void>;
  health(): RelayerHealth;      // { wbtBalance, spentToday, paused, reason }
};
export function startRelayer(deps: { db: Db; key: Hex32; rpc: string; budget: RelayerBudget }): Relayer {
  throw new Error('not implemented');
}

// settlements row (server/db.ts); the relayer is its only writer
type SettlementRow =
  | { ref: InvoiceRef; state: 'queued';    payer: Address; validBefore: bigint; signature: Signature }
  | { ref: InvoiceRef; state: 'broadcast'; payer: Address; validBefore: bigint; signature: Signature;
      rawTx: `0x${string}`; tx: TxHash; relayerNonce: number }
  | { ref: InvoiceRef; state: 'confirmed'; tx: TxHash; block: bigint; net: UsdtMicros }
  | { ref: InvoiceRef; state: 'refused';   reason: SettleRefusal; retryable: boolean };
```

`submit` pseudocode:

```
row = db.settlement(ref)
if row and row.state in {queued, broadcast, confirmed}: return view(row)        // double click, retry
inv = fold(events(ref)); require inv.phase == 'sent'          else refused(invoice_not_open)
auth = buildReceiveAuth({ ref, payee: inv.payee, gross: inv.gross, payer: intent.payer, ... })  // server terms only
require recoverTypedDataAddress(toTypedData(auth), intent.signature) == intent.payer   else refused(bad_signature)
require validBefore > now + 2 min                               else refused(expired, retryable)
require !budget.paused                                          else refused(relayer_paused, retryable)
require rateLimit(token, ip) ok                                 else refused(rate_limited, retryable)
require eth_call(settle(...)) succeeds                          else refused(simulation_reverted | insufficient_usdt)
db.upsertSettlement(ref, queued, ...)   // INSERT ... ON CONFLICT(ref) DO UPDATE WHERE state='refused' AND retryable
queue.push(ref); return { state: 'queued' }
```

Actor step (one ref at a time):

```
nonce  = db.nextRelayerNonce()               // seeded at boot from getTransactionCount(pending)
raw    = signTransaction(settle(...), nonce, gas = estimate * 1.2)
tx     = keccak256(raw)
db.markBroadcast(ref, raw, tx, nonce)        // persisted BEFORE the network sees it
sendRawTransaction(raw)                      // "already known" / "nonce too low" are not errors here
receipt = waitForReceipt(tx, 60 s)           // confirmed -> markConfirmed; reverted -> refused(simulation_reverted)
budget.record(receipt.gasUsed * gasPrice)
```

### Idempotency story, layer by layer

| Failure | What stops a double payment or a stuck invoice |
|---|---|
| Client double-clicks Pay | `settlements` PK `ref`; second `submit` returns the existing view. UI disables button too, but that is cosmetic. |
| Client re-signs (new `validBefore`) | Same nonce (nonce excludes time) so USDT `authorizationState` allows only one to land; contract `settled[ref]` also blocks. |
| Two different payers sign for one invoice | Different nonces, but `settled[ref]` reverts the second on chain; the second payer's funds never move. Simulation catches it before broadcast. |
| Relayer retries the same tx | Same `rawTx`, same hash; node returns "already known". |
| Crash after `markBroadcast`, before send | `reconcile`: no receipt, nonce unused, `settled[ref]` false -> rebroadcast the stored `rawTx`. |
| Crash after send, before receipt | `reconcile`: receipt found -> `markConfirmed`. |
| Crash before `markBroadcast` | Row is `queued`; reconcile re-enqueues; nothing was signed for the network. |
| Someone else settles it (permissionless) | `reconcile` reads `settled[ref]`, finds the `InvoiceSettled` log, marks confirmed with that tx. |
| Auth expires while queued | `reconcile` marks `refused(expired, retryable)`; client page offers "Tap to pay again" (one new signature). |

Every reconcile step reads current chain and DB state and applies only the difference, per make-operations-idempotent. The DB row is a cache of chain truth, never the truth.

### Relayer drain prevention (the one slide)

```
  Who can make us spend WBT?            What stops it
  ───────────────────────────────────   ─────────────────────────────────────────────────────
  1. Junk / reverting calls             We only ever build settle() ourselves from a DB invoice.
                                        No generic calldata endpoint. eth_call simulation first:
                                        a tx that would revert is never broadcast, so costs us 0.
  2. Spam of valid tiny payments        Every settle pays a 0.5% USDT fee (min invoice 5 USDT)
                                        >= its own gas. Spamming us means paying us.
  3. Many invoices, one attacker        Invoices need a signed-in 0G account; per-freelancer cap
                                        of 20 settles/day; per-PayToken and per-IP rate limit.
  4. Stolen relayer key                 The contract grants the relayer NO privilege. The key can
                                        only spend the hot wallet: <= 0.5 WBT (one faucet day).
  5. Gas price spike / runaway          Daily WBT spend cap + floor balance -> breaker pauses,
                                        pay page says "Payments resume shortly", nothing lost.
  Refill: treasury USDT fees -> YetiTrade USDT->WBT swap -> relayer (scripts/refill.ts, manual at hackathon).
  Business pays gas: yes, out of the fee it earns on that same payment.
```

### Anon-RPC read path (`src/web/chain/anon.ts`)

```ts
export type ChainReader = {
  settlementsTo(payee: Address): Promise<ChainSettlement[]>;     // getLogs InvoiceSettled, topic2 = payee
  settledRef(ref: InvoiceRef): Promise<ChainSettlement | null>;   // settled(ref) + log lookup
  usdtBalance(a: Address): Promise<UsdtMicros>;
  watchSettled(ref: InvoiceRef, onSettled: (s: ChainSettlement) => void): () => void; // 6 s poll
};
export type AnonState =
  | { s: 'booting'; progress: number }          // tor-js bootstrap
  | { s: 'ready' }
  | { s: 'failed'; error: string };             // UI offers "Read directly (reveals your IP)" opt-in
export type RpcMeter = { viaTor: number; direct: number; bootstrapDirect: 1 };

/** One per tab. Domain methods only; no viem client escapes this module. */
export function getChainReader(): Promise<ChainReader> { throw new Error('not implemented'); }
export function useAnonState(): AnonState { throw new Error('not implemented'); }
export function useRpcMeter(): RpcMeter { throw new Error('not implemented'); }
```

Internals, pseudocode:

```ts
const worker = new AnonRpcWorker({ address: TOR_JS_SPECIFIER, config: { gateways: GATEWAYS },
                                   preExisting: { rpcProvider: mainnetProvider } }); // the one disclosed direct read
const meteredFetch = (u, init) => { meter.viaTor++; return worker.fetch(u, init); };
const client = createPublicClient({
  chain: whitechainSepolia,
  transport: fallback([                               // Ankr may reject Tor exits; official RPC second
    http('https://rpc.ankr.com/whitechain_testnet', { fetchFn: meteredFetch, batch: true }),
    http('https://rpc.testnet.whitechain.io',      { fetchFn: meteredFetch, batch: true }),
  ]),                                                 // if fetchFn is unsupported: custom({ request }) over meteredFetch
  batch: { multicall: { deployless: false } },         // Multicall3 is deployed; fewer Tor round trips
});
```

Rules. The worker boots on app load (before the user needs a read), not on first read. The dashboard renders server data immediately with a "verifying privately" shimmer on paid totals, then swaps in chain-verified numbers. No silent direct fallback: if Tor fails, the user chooses, and the meter counts it as `direct`. The footer shows `Anon-RPC: 41/41 reads via Tor`.

Disclosed exclusions (README "Limitations"): the one bootstrap mainnet read that resolves the specifier; relayer writes and receipt polling, which come from Paid's server IP and expose no user; 0G calls, which are not RPC. Nothing a user's browser does on chain goes direct unless the user opts in.

### 0G call shapes (`src/server/zg.ts`, `src/server/ai.ts`)

```ts
export type ZgCredential = { kind: 'team'; apiKey: string } | { kind: 'user'; token: string }; // iAI: open question
export type ZgError =
  | { kind: 'no_private_provider' }      // 503 no_provider_for_trust_mode; never retried on a non-private mode
  | { kind: 'bad_output'; raw: string }  // JSON failed schema twice
  | { kind: 'http'; status: number };

export type Zg = {
  transcribe(audio: Blob, cred: ZgCredential): Promise<Result<Attested<string>, ZgError>>;
  chat<T>(task: TaskSpec<T>, input: TaskInput<T>, cred: ZgCredential): Promise<Result<Attested<T>, ZgError>>;
};
export type TaskSpec<T> = {
  task: ZgTask; model: 'glm-5.3' | '0gm-1.0-35b-a3b';
  system: string; render: (input: never) => string;   // structured state in, prompt string out
  schema: z.ZodType<T>;                                // parse model JSON into a domain type
};
export function createZg(): Zg { throw new Error('not implemented'); }
```

Wire, chat (draftInvoice, draftReminder, readReply, briefing):

```http
POST https://router-api.0g.ai/v1/chat/completions
Authorization: Bearer sk-...                      (server env only)
X-0G-Provider-Trust-Mode: private
Content-Type: application/json

{ "model": "glm-5.3", "verify_tee": true, "response_format": { "type": "json_object" },
  "messages": [{ "role": "system", "content": "<task system prompt + JSON shape>" },
               { "role": "user",   "content": "<rendered input>" }] }

200 -> { "choices": [...], "x_0g_trace": { "request_id": "...", "provider": "...", "billing": {...}, "tee_verified": true } }
       headers: ZG-Res-Key: ...
503 -> { "error": { "code": "no_provider_for_trust_mode" } }
```

Wire, transcription:

```http
POST https://router-api.0g.ai/v1/audio/transcriptions?verify_tee=true
X-0G-Provider-Trust-Mode: private
multipart: file=@note.webm, model=whisper-large-v3
```

Capture rule, in one function every call goes through: read `x_0g_trace` from the body (and `ZG-Res-Key` from headers), insert into `zg_receipts` keyed by `request_id`, then return `Attested<T>`. If `x_0g_trace` is missing on the transcription response (unverified), the receipt records `teeVerified: 'not_reported'` and `/proof` shows that honestly. JSON output parses through the task's zod schema; on failure, one repair turn, then `bad_output`.

Task registry (`src/server/ai.ts`) is one table, so adding a task means adding one row:

| Task | Model | Input | Output type |
|---|---|---|---|
| `draftInvoice` | glm-5.3 | transcript, freelancer's past clients | `InvoiceTerms` |
| `draftReminder` | glm-5.3 | terms, tone, history, language | `ReminderDraft` |
| `readReply` | glm-5.3 | terms, pasted reply, today | `ReplyReading` |
| `briefing` | glm-5.3 | ranked `BriefItem[]` | `string` headline |

Cost control: reminder drafts are cached by `(ref, tone, lastEventSeq)`, so opening Today twice does not re-bill; the cache key changes only when something the draft depends on changes.

### Server surface (`src/server/routes.ts`, the boundary)

| Route | Auth | Body (zod) | Returns |
|---|---|---|---|
| `POST /api/invoices/voice` | freelancer | multipart audio | `{kind:'drafted'|'private_ai_unavailable'|'unreadable', ...}` |
| `POST /api/invoices` | freelancer | typed terms | `InvoiceView` |
| `POST /api/invoices/:ref/commands` | freelancer | `Command` | `InvoiceView | Refusal` |
| `GET /api/book` | freelancer | | `InvoiceView[]` (with server-derived status) |
| `GET /api/today` | freelancer | | `Briefing` |
| `POST /api/invoices/:ref/replies/read` | freelancer | `{ text }` | `Attested<ReplyReading>` |
| `GET /api/pay/:token` | none (token is the capability) | | `PayView` |
| `POST /api/pay/:token` | none | `SubmitIntent` | `SettlementView` |
| `GET /api/proof` | freelancer | | `ZgReceipt[]` |

`api.invoices.send/edit/void` and `api.reminders.approve`/`api.replies.confirm` in the web client all post a `Command` to the one commands route; `decide` is the single gate. One way to change an invoice.

### Module map

```
paid/
├─ contracts/                     foundry
│  ├─ src/PaidSettlement.sol
│  ├─ script/Deploy.s.sol
│  └─ test/PaidSettlement.t.sol   fork test on 1874 against real USDT
├─ src/
│  ├─ domain/                     pure TS, no IO, imported by web and server
│  │  ├─ ids.ts  money.ts  attested.ts
│  │  ├─ invoice.ts               events, decide, fold, deriveStatus
│  │  ├─ collections.ts           tone ladder, planNext, rank
│  │  └─ settlement.ts            constants, nonceFor, buildReceiveAuth, toTypedData, feeOf
│  ├─ server/
│  │  ├─ main.ts                  Hono app, serves dist/web, starts relayer
│  │  ├─ routes.ts                boundary: auth, zod parse, call domain/services
│  │  ├─ db.ts                    SQLite (better-sqlite3), schema, append(ref, expectedSeq, events)
│  │  ├─ zg.ts                    0G transport + receipt capture
│  │  ├─ ai.ts                    task registry + briefing assembly
│  │  ├─ relayer.ts               single-writer actor, budget, reconcile
│  │  └─ auth.ts                  verify 0G Privy token -> FreelancerId
│  └─ web/
│     ├─ main.tsx  api.ts         typed client over routes
│     ├─ chain/anon.ts            ChainReader, AnonState, RpcMeter
│     ├─ wallet/payer.ts          PayerWallet (embedded, email login)
│     └─ routes/ Record Today InvoiceEdit Dashboard Pay Proof .tsx
├─ scripts/ refill.ts  seed-demo.ts  settle-once.ts
├─ WHITECHAIN_FEEDBACK.md  README.md  .env.example
```

`src/server/*` cannot be imported from `src/web/*` (eslint `no-restricted-imports` + separate tsconfig `paths`), so the relayer key and 0G key cannot leak into the bundle through a convenient import. Tracing any flow takes three files: route, domain, one server service.

### SQLite schema (`src/server/db.ts`)

```sql
CREATE TABLE freelancers (id TEXT PRIMARY KEY, payout TEXT NOT NULL, name TEXT, tz TEXT DEFAULT 'Asia/Kolkata');
CREATE TABLE invoices    (ref TEXT PRIMARY KEY, freelancer_id TEXT NOT NULL, pay_token TEXT UNIQUE, created_at TEXT);
CREATE TABLE invoice_events (ref TEXT, seq INTEGER, at TEXT, actor TEXT, body TEXT, PRIMARY KEY (ref, seq));
CREATE TABLE settlements (ref TEXT PRIMARY KEY, state TEXT, payer TEXT, valid_before TEXT, signature TEXT,
                          raw_tx TEXT, tx TEXT, relayer_nonce INTEGER, block TEXT, net TEXT, reason TEXT, retryable INTEGER);
CREATE TABLE zg_receipts (request_id TEXT PRIMARY KEY, task TEXT, model TEXT, provider TEXT, tee_verified TEXT,
                          res_key TEXT, billing TEXT, ref TEXT, at TEXT);
CREATE TABLE relayer_spend (day TEXT PRIMARY KEY, wei TEXT);
```

`append(ref, expectedSeq, events)` inserts at `expectedSeq + 1...` inside one transaction; a PK conflict means someone else appended first, so the route re-folds and re-decides (compare-and-swap, no lock).

### Wallet (`src/web/wallet/payer.ts`)

```ts
export type PayerWallet = { address: Address; signTypedData(td: TypedDataDefinition): Promise<Signature> };
/** Email-login embedded wallet from Paid's own Privy app (not the 0G app ID). Signing is offline
 *  EIP-712, so no chain support is needed from the provider; the domain names chainId 1874. */
export function payerWallet(): Promise<PayerWallet> { throw new Error('not implemented'); }
```

### Tech stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node 22, one process | relayer actor needs a long-lived single writer; no serverless |
| Server | Hono | tiny, typed routes, serves the SPA |
| Web | Vite + React + TanStack Router | dev on 5173 (iAI-allowed); prod build served on 3000 (iAI-allowed) |
| DB | SQLite via better-sqlite3 | one file, synchronous transactions make CAS append trivial |
| Validation | zod | one schema per boundary and per AI task |
| Chain | viem (browser + server), Foundry for contracts | typed data, recover, multicall, fork tests |
| Anon-RPC | `@ethereum/anon-rpc` AnonRpcWorker (tor-js) | browser-side, chain-agnostic `fetch` |
| AI | 0G router over plain `fetch` | need raw body (`x_0g_trace`) and headers (`ZG-Res-Key`); an SDK wrapper might hide them |
| Wallet | Privy embedded (payer); 0G Privy (freelancer sign-in) | email login, no seed phrase |
| Host | Railway with a volume | persistent SQLite + always-on relayer for the live link |

## Synthesis decision

## Tradeoffs accepted

- We accept two readers of "paid" (relayer receipt on the server, chain logs over Tor in the browser) in exchange for the server never reading the chain for users. Both are caches of one truth, the contract's `settled[ref]`, and `deriveStatus` ranks chain over relayer.
- We accept a 0.5% fee on the freelancer in exchange for a drain answer that is economic, not just rate limits: every relayed tx funds its own gas.
- We accept that terms are frozen at Send (the nonce commits to payee and gross) in exchange for a signature that cannot be redirected. Changing an invoice after sending means void and reissue.
- We accept an event log and a fold for a CRUD-looking app. It looks like over-engineering; it is what lets the agent, the freelancer, and the relayer write without sharing a `status` column, and it gives the agent a history to reason over.
- We accept no contract owner, no pause, no upgrade. A bug means redeploying a new address, in exchange for a verification-friendly contract with no admin key to explain or steal.
- We accept sending reminders through WhatsApp/mailto deep links from the freelancer's own account in exchange for zero email infrastructure and messages that come from the freelancer, not a no-reply bot.
- We accept no fallback to a non-private model when private transcription is down. The UI offers typing instead. Privacy is the product claim; a silent downgrade would break it.
- We accept that a real foreign client needs USDT already. The demo client is a DAO that pays contractors in USDT; `PayView` has an `insufficient_usdt` state that is the onramp seam.

## Alternatives considered

- **Mutable `invoices.status` column written by every actor.** Smallest diff on day one. It loses because the relayer, the agent, and the freelancer would all write one field, crash recovery has to guess what the last writer meant, and the agent loses the history it needs to escalate tone. Shallow interface, split ownership.
- **ERC-4337 smart accounts with our own paymaster.** EntryPoint exists on 1874, but no bundler accepts 1874, so we would run a bundler, write a paymaster, and explain both. EIP-3009 on official USDT already gives gasless payment with one signature and a far smaller surface.
- **No contract: relayer calls `USDT.transferWithAuthorization(payer -> freelancer)` directly.** Fails the "deploy and verify a contract" rule, has no place to take a gas-funding fee, and the payer's signature names the freelancer EOA, so there is no invoice binding on chain.
- **Contract-level EIP-712 `SettleInvoice` struct signed separately from the USDT authorization.** Two signatures (or one wrapped) and a second domain to hardcode. Deriving the USDT nonce from the terms gets the same binding with one signature and zero new typed data.
- **Server-side chain reads routed through Anon-RPC in Node.** Raises the traffic number but anonymizes Paid's own server IP, which protects nobody. Judges score "deliberate, disclosed tradeoff"; putting all user reads in the browser is the honest version.

## Implementation reconciliation

## Open questions and risks

- iAI bonus: does the 0G router accept a per-user credential from the 0G Privy login so that the user's own credit balance drops? If not, is a "credits used" display from `x_0g_trace.billing` against the team key acceptable? `ZgCredential` keeps both shapes until someone asks at the 0G booth.
- Does Paid's own Privy embedded wallet sign EIP-712 with `chainId: 1874` in the domain without the chain being configured? If not, do we register 1874 as a custom chain, or fall back to a device key in IndexedDB for the demo (no seed phrase, but loses funds with the browser)?
- Does TetherTokenV2 at `0x2642...26F7` expose the `(v, r, s)` overload of `receiveWithAuthorization`, the `bytes signature` overload, or both? The fork test answers this in the first hour.
- Which verifier API does the Whitechain explorer speak (Blockscout, Etherscan-compatible, or manual only)?
- Does private-mode `whisper-large-v3` exist on the day? With one provider, should the demo pre-record the voice note so a retry is cheap?
- Tor bootstrap on venue Wi-Fi: how many seconds until `ready`, and does Ankr reject Tor exits? If both RPCs reject exits, is there a third 1874 RPC?
- Does viem `http()` accept `fetchFn` in the pinned version, or do we use `custom({ request })`?
- Is glm-5.3 good enough at Hinglish to not embarrass the demo? Should language default to English with Hinglish as a toggle?
- Relayer gas pricing: 1874 gas price is unknown. Is 0.5 WBT a day enough for the demo plus judges trying it (84k gas per settle)?
- Team size: with fewer than three people, is the briefing headline the first cut, leaving the deterministic Today list?

## Build sequence (each step ends demoable)

1. Hour 0 to 4: `PaidSettlement` + fork test + deploy + verify + `scripts/settle-once.ts` lands one real USDT settlement. README gets the explorer link.
2. Hour 4 to 10: `domain/` types, `decide`/`fold`, SQLite, routes, typed invoice create/send, Pay page with embedded wallet, relayer `submit` + reconcile.
3. Hour 10 to 16: `zg.ts` with receipt capture, voice to draft, `/proof` page.
4. Hour 16 to 24: collections policy table, Today view, reminder drafts, reply reading, deep links.
5. Hour 24 to 30: Anon-RPC reader, meter, boot UX, dashboard merge.
6. Hour 30 to 36: Railway deploy, seed data, demo rehearsal, video, WHITECHAIN_FEEDBACK.md.

## Next implementation step

Write `contracts/test/PaidSettlement.t.sol` as a 1874 fork test that signs a `ReceiveWithAuthorization` whose nonce is `nonceFor(ref, payee, gross)` against the real USDT, because every other module depends on that nonce scheme working.

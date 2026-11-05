# Paid: candidate 4, the collections agent as the kernel

Shape in one line: one agent loop runs every AI task in the product. Invoices, reminders and approvals are its tools. Money moves only inside a non-custodial settlement contract, and no model output can reach that contract.

## Problem

Paid lets an Indian freelancer bill foreign clients. The client pays USDT on Whitechain Sepolia (chain 1874) with no visible crypto step and no gas. The team has 36 hours to build it and win three sponsor tracks.

Constraints this design must honor, from GROUNDING.md:

- 0G: inference sits in the main flow, request IDs are captured, and private trust mode is on. Without 0G, voice intake, invoice drafting, reply reading and the daily plan all stop. The app then becomes a manual invoice form. That is the one-sentence answer to "what breaks if 0G is removed".
- EF Anon-RPC: every chain read goes through Anon-RPC by default. A visible counter shows the share of traffic that is anonymized.
- Whitechain: the contracts deploy and verify on 1874. At least one payment settles in official USDT `0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7` through EIP-3009. The relayer drain story fits on one slide.
- Settlement is idempotent under a double click, a relayer retry, and a crash between broadcast and the DB write.
- Secrets stay server-side. The iAI sign-in works only on localhost ports, so the demo runs locally too.
- Fallbacks are honest. No faked AI and no faked payments.

The non-obvious part is that three forces meet in one flow. A model proposes, a human approves, and the chain settles. A design where the model can reach money or the send button fails the drain review and the 0G "AI could be removed unnoticed" test at once. This shape answers both: the agent is the only AI entry point, and authority is cut in its tool table, not in its prompt.

## Usage (caller's view)

Each block is the code the caller writes. The types below are derived from these blocks.

### Freelancer (web app)

```ts
// apps/web/app/(app)/voice/page.tsx
const run = await collections.run({ tag: 'voice_intake', freelancerId, audio });
run.drafts;    // Invoice[] the agent created through invoice.draft
run.receipts;  // ZgReceipt[] rendered as request-ID chips in the UI

await invoices.edit(draft.id, { lines, dueOn });   // human command
await invoices.send(draft.id);                     // human command, the freelancer's own approval
```

```ts
// apps/web/app/api/approvals/[id]/route.ts
await approvals.approve(approvalId);   // runs the stored human command, e.g. message.sendReminder
```

### Client (pay link)

```ts
// apps/web/app/pay/[token]/page.tsx
const quote = await settlement.quote(token);          // anon read: amount, payee, nonce, validBefore
const auth  = await payer.authorize(quote);           // EIP-712 signed in the browser, no gas, no prompt
const intent = await settlement.submit(token, auth);  // idempotent on invoiceId
const status = await settlement.status(intent.id);    // queued | broadcasting | mined | settled | refused | reverted
```

### Collections agent (daily tick and client replies)

```ts
// apps/web/app/api/agent/tick/route.ts
const run = await collections.run({ tag: 'daily_tick', freelancerId, today });
run.plan;       // string[] what it looked at and why it acted
run.approvals;  // Approval[] reminders waiting for one tap

// apps/web/app/api/inbound/reply/route.ts
await collections.run({ tag: 'client_reply', freelancerId, invoiceId, replyText, receivedAt });
```

### Chain reads (any module)

```ts
const chain = chainReader();                  // Anon-RPC by default
const settled = await chain.isSettled(invoiceId);
```

Payments are never reported by the agent. The indexer observes them and then calls `collections.run({ tag: 'payment_observed', ... })`.

## Shape

### Load-bearing decisions

1. The collections agent is the only AI entry point. Voice intake, drafting, reply reading and the daily plan are all runs of one loop.
2. Invoices are tools. `agentTools` is derived from the single command table minus the `human` entries, so `invoice.send`, `invoice.edit`, and `message.sendReminder` cannot be reached by a model. Per **encode-lessons-in-structure**, this is a type-level filter, not a prompt line.
3. Paid status comes from one place: a `Settled` log at depth 2. No model claim and no client claim moves an invoice to `paid`.
4. The payee is bound by the signature, not by storage. The EIP-3009 nonce is `keccak256(abi.encode(invoiceId, payee, amount))`, so the payer signs over the payee and amount. There is no on-chain commitment transaction. One payment costs one transaction.
5. The relayer's pipeline uses branded stages. `broadcast` accepts only a `Simulated` intent, and `simulate` accepts only a `Guarded` one. An unguarded intent cannot reach the chain by type.
6. Deterministic rules own deterministic things. Overdue status, tone escalation, and the amount that gets paid are pure functions. The model writes words inside a tone the code chose.

### Types (TypeScript sketch)

```ts
// packages/core/src/ids.ts
declare const brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type FreelancerId = Brand<string, 'FreelancerId'>;
export type ClientId     = Brand<string, 'ClientId'>;
export type InvoiceId    = Brand<`0x${string}`, 'InvoiceId'>;     // bytes32 on chain
export type PayTokenHash = Brand<`0x${string}`, 'PayTokenHash'>;  // sha256 of the pay-link secret; raw token never stored
export type ReplyId      = Brand<string, 'ReplyId'>;
export type RunId        = Brand<string, 'RunId'>;
export type IntentId     = Brand<string, 'IntentId'>;
export type ApprovalId   = Brand<string, 'ApprovalId'>;
export type ZgRequestId  = Brand<string, 'ZgRequestId'>;          // x_0g_trace.request_id
export type EvmAddress   = Brand<`0x${string}`, 'EvmAddress'>;
export type TxHash       = Brand<`0x${string}`, 'TxHash'>;
export type Bytes32      = Brand<`0x${string}`, 'Bytes32'>;
export type Instant      = Brand<number, 'Instant'>;              // unix seconds
export type IsoDate      = Brand<string, 'IsoDate'>;              // YYYY-MM-DD in freelancer tz

// packages/core/src/money.ts
export type UsdtUnits = Brand<bigint, 'UsdtUnits'>;               // 6 decimals (assumed, verify with decimals())
export declare function parseUsdt(input: string): UsdtUnits;     // "600.00" -> 600_000_000n; throws beyond 6 places
export declare function formatUsdt(u: UsdtUnits): string;
export declare function nonceFor(invoiceId: InvoiceId, payee: EvmAddress, amount: UsdtUnits): Bytes32;
// nonceFor = keccak256(encodeAbiParameters(bytes32, address, uint256))
```

```ts
// packages/core/src/invoice/types.ts
export type LineItem = { description: string; qty: number; unit: UsdtUnits };

export type Invoice = {
  id: InvoiceId;
  freelancerId: FreelancerId;
  clientId: ClientId;
  lines: readonly LineItem[];       // total is derived by totalOf(lines), never stored
  dueOn: IsoDate;
  payee: EvmAddress;                // set at send, frozen after
  state: InvoiceState;
};

export type InvoiceState =
  | { tag: 'draft' }
  | { tag: 'sent'; sentAt: Instant; payTokenHash: PayTokenHash }
  | { tag: 'promised'; sentAt: Instant; payTokenHash: PayTokenHash; promisedOn: IsoDate; fromReply: ReplyId }
  | { tag: 'paid'; sentAt: Instant; payTokenHash: PayTokenHash; settledBy: SettlementRef }
  | { tag: 'void'; reason: string };

export type SettlementRef = { txHash: TxHash; logIndex: number; blockNumber: bigint; observedAt: Instant };

export type InvoiceEvent =
  | { tag: 'sent'; at: Instant; payTokenHash: PayTokenHash }
  | { tag: 'promised'; at: Instant; promisedOn: IsoDate; fromReply: ReplyId }
  | { tag: 'settled'; at: Instant; settledBy: SettlementRef }
  | { tag: 'voided'; at: Instant; reason: string };

export type TransitionError =
  | { tag: 'illegal'; from: InvoiceState['tag']; event: InvoiceEvent['tag'] }
  | { tag: 'payment_on_void'; invoiceId: InvoiceId };   // money arrived for a void invoice: raise an anomaly

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };
```

```ts
// packages/core/src/invoice/transition.ts
// Pure. Same (state, event) always yields the same answer. A repeated 'settled' on a paid
// invoice returns changed: false, which makes the indexer idempotent without a lock.
export declare function transition(
  state: InvoiceState,
  event: InvoiceEvent,
): Result<{ state: InvoiceState; changed: boolean }, TransitionError>;
```

```ts
// packages/core/src/invoice/receivable.ts
export type Receivable = {
  invoice: Invoice;
  status: 'draft' | 'open' | 'overdue' | 'paid' | 'void';
  daysLate: number;
  tone: 'friendly' | 'firm' | 'final';   // escalation is code, not model judgment
};
export declare function receivable(inv: Invoice, today: IsoDate): Receivable;
// overdue = sent|promised and today > (promisedOn ?? dueOn). Derived, never stored.
```

```ts
// packages/core/src/commands.ts  THE command table: the only list of operations
export const commands = {
  'invoice.list':          { policy: 'read',   input: ListInput,         run: listReceivables },
  'invoice.get':           { policy: 'read',   input: GetInput,          run: getInvoice },
  'invoice.draft':         { policy: 'auto',   input: DraftInput,        run: draftInvoice },
  'invoice.recordPromise': { policy: 'auto',   input: PromiseInput,      run: recordPromise },
  'invoice.proposeSend':   { policy: 'auto',   input: SendInput,         run: proposeSend },   // creates an Approval
  'message.draftReminder': { policy: 'auto',   input: ReminderInput,     run: draftReminder },
  'invoice.edit':          { policy: 'human',  input: EditInput,         run: editInvoice },
  'invoice.send':          { policy: 'human',  input: SendInput,         run: sendInvoice },
  'message.sendReminder':  { policy: 'human',  input: SendReminderInput, run: sendReminder },
} as const satisfies CommandTable;

export type CommandName = keyof typeof commands;
export type HumanOnly = { [K in CommandName]: (typeof commands)[K]['policy'] extends 'human' ? K : never }[CommandName];
// No settlement command exists here. Invoice.paid is set only by settlement/indexer.ts.
```

```ts
// packages/agent/src/types.ts
export type AgentEvent =
  | { tag: 'voice_intake'; freelancerId: FreelancerId; audio: AudioRef }
  | { tag: 'client_reply'; freelancerId: FreelancerId; invoiceId: InvoiceId; replyText: string; receivedAt: Instant }
  | { tag: 'daily_tick'; freelancerId: FreelancerId; today: IsoDate }
  | { tag: 'payment_observed'; freelancerId: FreelancerId; invoiceId: InvoiceId; settledBy: SettlementRef };

export type ZgReceipt = {
  requestId: ZgRequestId;
  purpose: 'asr' | 'draft' | 'reply' | 'plan';
  model: string;
  teeVerified: boolean;
  at: Instant;
};

export type AgentStep =
  | { tag: 'model'; receipt: ZgReceipt; toolCalls: string[] }
  | { tag: 'tool'; name: AgentToolName; ok: boolean; error?: 'unknown_tool' | 'bad_args' | 'domain_refusal' };

export type AgentRun = {
  id: RunId;
  event: AgentEvent['tag'];
  startedAt: Instant;
  steps: AgentStep[];
  plan: string[];
  approvals: ApprovalId[];
  receipts: ZgReceipt[];
};
```

```ts
// packages/settlement/src/types.ts
// What the hidden wallet signs. Parsed at the HTTP boundary with zod, then trusted inside.
export type Authorization = {
  payer: EvmAddress;
  invoiceId: InvoiceId;
  payee: EvmAddress;
  amount: UsdtUnits;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Bytes32;                         // must equal nonceFor(invoiceId, payee, amount)
  sig: { v: 27 | 28; r: Bytes32; s: Bytes32 };
};

// Stage brands. Each stage is produced only by the function that checks it.
declare const guardedTag: unique symbol;
declare const simulatedTag: unique symbol;
export type Draft     = { tag: 'draft'; auth: Authorization };
export type Guarded   = Draft & { readonly [guardedTag]: true };
export type Simulated = Guarded & { readonly [simulatedTag]: true };

export type GuardRefusal =
  | 'invoice_not_sent' | 'amount_mismatch' | 'payee_mismatch' | 'bad_signature' | 'window_expired'
  | 'over_ceiling' | 'payer_rate_limited' | 'daily_gas_cap' | 'breaker_open' | 'already_settled';

export type Attempt =
  | { tag: 'queued'; intentId: IntentId; invoiceId: InvoiceId; auth: Authorization }
  | { tag: 'broadcasting'; intentId: IntentId; invoiceId: InvoiceId; relayerNonce: bigint; rawTx: `0x${string}`; txHash: TxHash }
  | { tag: 'mined'; intentId: IntentId; txHash: TxHash; blockNumber: bigint }
  | { tag: 'settled'; intentId: IntentId; txHash: TxHash; logIndex: number; blockNumber: bigint }
  | { tag: 'refused'; intentId: IntentId; reason: GuardRefusal }
  | { tag: 'reverted'; intentId: IntentId; txHash: TxHash; reason: string };
```

### Module map

```
apps/web/                                  Next.js App Router. UI and route handlers. Thin.
  app/(app)/voice/page.tsx                 freelancer voice intake
  app/(app)/invoices/[id]/page.tsx         review, edit, send (human commands)
  app/(app)/today/page.tsx                 daily plan, approvals, receivables, 0G receipts, Anon-RPC share
  app/pay/[token]/page.tsx                 client pay link, browser-side EIP-712 signing
  app/api/commands/[name]/route.ts         human commands, one route, zod-parsed
  app/api/inbound/reply/route.ts           forwarded or pasted client replies
  instrumentation.ts                       starts sweep and indexer loops on the long-lived server

packages/core/src/
  ids.ts                                   branded IDs
  money.ts                                 UsdtUnits, parse and format, nonceFor
  invoice/types.ts                         Invoice, InvoiceState, InvoiceEvent
  invoice/transition.ts                    pure state machine
  invoice/receivable.ts                    derived overdue, daysLate, tone
  commands.ts                              the one command table

packages/agent/src/
  loop.ts                                  the collections agent. The only AI entry point.
  tools.ts                                 agentTools = commands without 'human'; toolSpecs() from zod
  world.ts                                 receivables snapshot for the prompt (derived, no model date math)
  prompts.ts                               policy text, language rules (English, Hinglish)

packages/zerog/src/
  client.ts                                chat(), transcribe(); trust-mode header; trace capture
  receipts.ts                              ZgReceipt persistence and the 'no trace, no success' rule

packages/chain/src/
  transport.ts                             ReadPath (anon | direct), traffic counter
  reader.ts                                typed reads: isSettled, usdtBalance, logs
  abi.ts                                   generated from forge out/, never hand-edited
  eip3009.ts                               EIP-712 domain and ReceiveWithAuthorization types

packages/settlement/src/
  types.ts                                 Authorization, stage brands, Attempt, GuardRefusal
  intents.ts                               quote(token), submit(token, auth); idempotent on invoiceId
  guard.ts                                 drain policy. Returns Guarded or a refusal.
  simulate.ts                              eth_call from relayer. Returns Simulated or a refusal.
  broadcast.ts                             the only function that takes Simulated. Write-ahead log first.
  sweep.ts                                 recovery of broadcasting rows, decided from chain state
  indexer.ts                               Settled log cursor; applies 'settled' to invoices

packages/db/src/schema.ts                  Drizzle schema, every table in one file

contracts/
  src/InvoiceSettlement.sol
  test/InvoiceSettlement.t.sol             fork test against official USDT
  script/Deploy.s.sol                      deploy plus verify, one command
```

Interface depth. The public surface of `agent` is one function, `run(event)`. It hides the prompt, the tool loop, the policy filter, the 0G trace capture, and the retry rules. The public surface of `settlement` is `quote`, `submit`, and `status`. It hides the relayer key, the nonce, the write-ahead log, the guard, and the sweep.

### The collections agent loop

```ts
// packages/agent/src/loop.ts
const MAX_TURNS = 8;

export async function run(event: AgentEvent, deps: AgentDeps): Promise<AgentRun> {
  const r = newRun(event, deps.clock.now());
  const input = event.tag === 'voice_intake' ? { ...event, text: await transcribeInto(event, deps, r) } : event;
  const world = await deps.world.snapshot(event.freelancerId, deps.clock.today());   // receivable() for each invoice
  const messages = [system(POLICY_PROMPT), user(render(input, world))];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const reply = await deps.zg.chat({ purpose: purposeOf(event), messages, tools: toolSpecs() });
    r.receipts.push(reply.receipt);                                  // no receipt, no step
    if (reply.message.toolCalls.length === 0) break;
    for (const call of reply.message.toolCalls) {
      messages.push(await execute(call, deps, r));                   // becomes a tool message
    }
  }
  return persist(r, deps);
}

async function execute(call: ToolCall, deps: AgentDeps, r: AgentRun): Promise<ToolMessage> {
  const entry = agentTools[call.name as AgentToolName];              // 'human' commands are absent here
  if (!entry) return toolError(call, 'unknown_tool');
  const args = entry.input.safeParse(JSON.parse(call.arguments));    // boundary parse
  if (!args.success) return toolError(call, 'bad_args');
  const out = await entry.run(args.data, deps.ctx);                  // same function the UI calls
  return toolResult(call, out);                                      // domain refusals come back as data
}
```

Reading the loop: the model sees a derived world snapshot. It can read, draft, record a promise, and propose a send. Each of those is a command. A proposal writes an `Approval` row. The freelancer's tap runs the stored `human` command. Nothing in the loop can send an email or change `paid`.

Demo fallbacks stay honest. If the private provider is down, the run stops with `ZgUnavailable`, and the UI says so. A typed-text intake path exists, labeled as typed, not as voice.

### 0G call shapes

```ts
// packages/zerog/src/client.ts
const ZG = 'https://router-api.0g.ai/v1';
const PRIVATE = { 'X-0G-Provider-Trust-Mode': 'private' } as const;

export class ZgUnavailable extends Error {}      // 503 no_provider_for_trust_mode, or missing trace
export class ZgTraceMissing extends Error {}     // body had no x_0g_trace: the call failed, we do not fake success

// Transcription. Voice intake.
// POST {ZG}/audio/transcriptions?verify_tee=true   multipart: file, model=whisper-large-v3
// headers: Authorization: Bearer $ZG_API_KEY, PRIVATE
// reads: body.text, body.x_0g_trace.{request_id, provider, tee_verified}
export declare function transcribe(audio: Blob, purpose: 'asr'): Promise<{ text: string; receipt: ZgReceipt }>;

// Chat with tools. Drafting, reply reading, plan, reminders: all one call shape.
// POST {ZG}/chat/completions   body: { model: 'glm-5.3', messages, tools, verify_tee: true }
// headers: Authorization: Bearer $ZG_API_KEY, PRIVATE
// reads: choices[0].message (content, tool_calls), x_0g_trace.{request_id, provider, tee_verified}
export declare function chat(input: ChatInput, purpose: 'draft' | 'reply' | 'plan' | 'reminder'):
  Promise<{ message: AssistantMessage; receipt: ZgReceipt }>;

// Capture rule: receipt = parseTrace(body) runs on every response before anything else reads the body.
// It throws ZgTraceMissing when x_0g_trace.request_id is absent. Receipts persist in inference_calls
// with the run id. The UI and the README both read request IDs from that table.
```

Model choice: `glm-5.3` for chat with tools, since it is private-capable and supports `tools`. `response_format` stays on `json_object`, since `json_schema` is unverified. Qwen vision and omni models are TeeTLS, so they are excluded.

### Anon-RPC read path

```ts
// packages/chain/src/transport.ts
export type ReadPath =
  | { tag: 'anon'; worker: AnonRpcWorker }
  | { tag: 'direct'; reason: 'worker_boot_failed' | 'bootstrap_specifier' | 'demo_fallback' };

// Every request increments traffic[path.tag]. The footer on /today shows anon / (anon + direct).
export declare function chainClient(path: ReadPath): PublicClient;
// anon: viem http(RPC, { fetchFn: worker.fetch }). If viem rejects fetchFn, use custom({ request }) that POSTs
// the JSON-RPC body through worker.fetch. RPC order: rpc.ankr.com/whitechain_testnet, then rpc.testnet.whitechain.io.
```

Who reads what:

- Browser (pay page and /today): reads and writes go through the anon worker. The worker boots when the page loads, so bootstrap delay runs behind the first paint, not behind the pay button.
- Server (indexer and relayer): uses the same `chainClient`. If the worker does not run in Node, the server uses `direct` with reason `worker_boot_failed`, and the counter records it.
- Disclosed exceptions: the one bootstrap read that resolves the specifier contract on mainnet or Sepolia is not anonymized. Demo fallback goes direct with a banner. Both show in the counter.

### Settlement contract (Solidity sketch)

```solidity
// contracts/src/InvoiceSettlement.sol
// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IUsdtEip3009 {
    function receiveWithAuthorization(
        address from, address to, uint256 value, uint256 validAfter, uint256 validBefore,
        bytes32 nonce, uint8 v, bytes32 r, bytes32 s
    ) external;
    function transfer(address to, uint256 value) external;   // no bool return on some USDT builds
}

contract InvoiceSettlement {
    IUsdtEip3009 public immutable usdt;
    address public immutable relayer;                         // immutable: no admin, no pause, no upgrade
    mapping(bytes32 invoiceId => bool) public settled;

    error NotRelayer();
    error AlreadySettled();

    event Settled(bytes32 indexed invoiceId, address indexed payer, address indexed payee, uint256 amount, bytes32 nonce);

    constructor(IUsdtEip3009 usdt_, address relayer_) {
        usdt = usdt_;
        relayer = relayer_;
    }

    /// Everything that moves money is covered by the payer's signature: from (recovered),
    /// to (this contract), value (amount), the validity window, and the nonce, which hashes
    /// (invoiceId, payee, amount). The relayer chooses timing and pays gas, and nothing else.
    function settle(
        bytes32 invoiceId, address payer, address payee, uint256 amount,
        uint256 validAfter, uint256 validBefore, uint8 v, bytes32 r, bytes32 s
    ) external {
        if (msg.sender != relayer) revert NotRelayer();
        if (settled[invoiceId]) revert AlreadySettled();
        settled[invoiceId] = true;                            // effects before interactions
        bytes32 nonce = keccak256(abi.encode(invoiceId, payee, amount));
        usdt.receiveWithAuthorization(payer, address(this), amount, validAfter, validBefore, nonce, v, r, s);
        usdt.transfer(payee, amount);                         // reverts on failure; no USDT stays here
        emit Settled(invoiceId, payer, payee, amount, nonce);
    }
}
```

Deploy and verify: `forge script script/Deploy.s.sol --rpc-url <1874 RPC> --broadcast`, then `forge verify-contract` with the Whitechain explorer verifier. The constructor takes the USDT proxy address and the relayer EOA. Both are recorded in `contracts/deployments/1874.json`, and the README links the verified address.

Fork test list (`test/InvoiceSettlement.t.sol`):

1. Payer signs ReceiveWithAuthorization over the nonce for (invoiceId, payee, amount). `settle` moves exactly `amount` to payee and emits `Settled`.
2. Second `settle` with the same invoiceId reverts `AlreadySettled`.
3. Replay of the same signature under a new invoiceId fails in the token (`authorization is used`).
4. A relayer that changes `payee` or `amount` makes the recovered signer wrong, so the call reverts.
5. An expired `validBefore` reverts, and the `settled` flag rolls back with it.
6. A caller other than the relayer reverts `NotRelayer`.

EIP-712 domain for the payer's hidden wallet, hardcoded because `eip712Domain()` reverts on the token: `name: "Tether USD"`, `version: "1"`, `chainId: 1874`, `verifyingContract: 0xcedf...55a7`. Type: `ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)`. A test recovers the signer from a live-signed payload, so a wrong domain fails loudly.

### Relayer drain prevention

One-slide version: the relayer can delay a payment or pay its gas. It cannot redirect money.

| Attack or failure | What stops it |
|---|---|
| Relayer key drained through arbitrary calls | The key calls one function on one contract. `settle` is the only function the code ever encodes. |
| Relayer holds the payer's USDT | It never does. Each payment moves in one transaction, from payer to payee inside `settle`. |
| Forged or altered payment through the relayer | All economic fields are covered by the payer's signature. The guard checks the signature off-chain too. |
| Garbage submissions that burn gas | `guard` checks the signature, window, and invoice state. `simulate` runs `eth_call`. A revert never reaches broadcast, so it costs nothing. |
| Race between simulate and broadcast | A payer balance that drops in that gap reverts on chain and costs gas. Bounded by the caps below. |
| Gas spend spikes | Per-tx gas limit of 180k (a relayed EIP-3009 settles at 84,429 gas live, and `settle` adds the forward). Daily wei cap. Breaker opens when the cap is hit. |
| Spam from one payer or IP | Per-payer and per-IP rate limit on `submit`. |
| Large unrelated flows | Amount ceiling per invoice in v1. |
| Relayer runs dry | Breaker opens below a WBT floor. Refusal reason `breaker_open` is shown to the client as a retry, not as a failure. |
| Relayer key compromise | Its only power is to delay or gas-pay valid signed payments. Rotation means redeploy, because `relayer` is immutable. |

Gas is funded from a treasury wallet. A top-up is a manual faucet step for the demo, and a hard cap on top-ups per day.

The guard is one function with a brand as its return type:

```ts
// packages/settlement/src/guard.ts
export declare function guard(d: Draft, ctx: GuardContext): Result<Guarded, GuardRefusal>;
// ctx carries: the invoice (must be sent, payee and amount must match), the clock,
// the daily gas ledger, the rate limiter, and the breaker state.

// packages/settlement/src/broadcast.ts
export declare function broadcast(s: Simulated, wal: AttemptStore): Promise<Attempt>;
// The only function that takes Simulated. It writes the attempt row (with rawTx and relayerNonce)
// before calling sendRawTransaction.
```

### Idempotency of settlement

The chain holds the authority, and the database holds the work queue. Four layers, each safe alone.

1. Client double-click. `settlement_attempts` has a partial unique index on `invoice_id` where the tag is one of `queued`, `broadcasting`, `mined`, `settled`. A second `submit` returns the existing attempt. A `refused` or `reverted` attempt does not block a retry.
2. Relayer retry. The attempt stores `relayerNonce` and `rawTx` before the first broadcast. Every retry re-sends the same raw bytes, so the node sees the same hash. The relayer never builds a second transaction for the same attempt.
3. Crash between broadcast and DB write. `broadcasting` rows are recovered by `sweep.ts`, and the decision comes from chain state, not from the DB:
   - Receipt for `txHash` exists: move to `mined`, then `settled` once the log is at depth 2.
   - No receipt and `settled(invoiceId)` is true on chain: another copy landed. Mark `settled` from the log.
   - No receipt and `settled` is false: re-send `rawTx`. If the node says nonce too low, re-read receipts and `settled` again.
4. Crash after mined, before the invoice write. `indexer.ts` scans `Settled` logs from a stored cursor. Rows upsert on `(tx_hash, log_index)`, and `transition(state, settled)` returns `changed: false` on a paid invoice. Reprocessing is a no-op.

The contract adds two guards that do not depend on the server: `settled[invoiceId]` and the token's own nonce table. Together they mean one invoice settles at most once, even if every server process is killed mid-flight.

A reverted attempt is retryable with the same signature while `validBefore` has not passed. The nonce was never consumed, because the revert rolled it back.

### Data store

Postgres on a long-lived host, through Drizzle. Tables in `packages/db/src/schema.ts`:

- `freelancers`, `clients`
- `invoices`: projection of `state` and the frozen fields
- `invoice_events`: append-only, `event_id` unique, so each event applies once
- `agent_runs`, `agent_steps`
- `inference_calls`: request ID, purpose, model, run ID, `tee_verified`
- `approvals`: pending, approved, executed, rejected, plus the stored human command and args
- `settlement_attempts`: the write-ahead log, with the partial unique index above
- `chain_events`: primary key `(tx_hash, log_index)`, plus the indexer cursor
- `pay_links`: `token_hash` primary key, `invoice_id`

The raw pay-link token exists only in the client's URL. The server stores its hash.

## Synthesis decision

## Tradeoffs accepted

- We accept a payee that is bound by signature and not by on-chain storage, in exchange for one transaction per payment. An outside reader sees the invoice ID and nonce on chain, not the invoice.
- We accept whole-invoice payment only. Partial payments would need a second nonce scheme and a second state, so they wait.
- We accept an immutable relayer with no pause and no upgrade. The cost is a redeploy on key rotation. The gain is that no admin key can redirect funds, and the contract stays small enough to verify on day one.
- We accept one agent loop instead of a pipeline. Each daily tick takes several model turns and several seconds, and the UI streams the plan to hide that. A pipeline would be faster to a single answer but would split the AI across four services, and the 0G "removable" test would be harder to show.
- We accept a long-lived Node host (Railway) instead of serverless. The relayer's write-ahead recovery and the indexer need a running process. A serverless cron would make recovery a one-minute delay.
- We accept a browser-held payer key in IndexedDB. Losing the browser loses the funds. That is a demo risk, and the onramp and custody seam is a later build.
- We accept no fallback from private 0G to a public provider. A failed call shows as failed. That costs demo reliability and keeps the "no faked AI" rule and the 0G prize rule intact.
- We accept a human tap before every send. It slows the demo by one click, and it is the freelancer's trust story.
- We accept that Paid charges no fee in v1. The treasury pays gas, and a USDT fee parameter comes later. The "how the business pays gas" answer is the treasury line plus the daily cap.
- We accept that the agent can propose a send but never execute one. A bad reminder costs a rejected approval, not an email.

## Alternatives considered

1. Pipeline of services (intake, invoices, collections job, settlement). Rejected. The AI shows up in four places with four prompts and four trace paths. The collections job becomes a cron, and the product no longer centers on the agent. Callers must coordinate four services to finish one action, so the public surface is shallow.
2. Commit-then-settle with an on-chain invoice registry. Rejected. It adds a relayer transaction per invoice, and each one is gas that an attacker can try to trigger. The signature already binds the payee through the nonce, so the registry adds surface and no safety.
3. Embedded wallet SDK for the payer. Rejected. Grounding says there is no verified embedded-wallet provider for 1874, and the thirdweb bundler rejects it. A browser-held key is the only path that works today.
4. Separate relayer service with its own queue and database. Rejected for v1. The split puts attempt state in two owners, which is the split-ownership red flag. The relayer stays an isolated module with its own key and one exported function. It can be lifted into a service later without changing callers.
5. Off-chain-only settlement, with EOA relaying and no contract. Rejected. It fails the "deployed and verified contract" requirement, and it gives the drain review nothing to point at.
6. Serverless deploy with cron recovery. Rejected. Recovery would run once a minute, and the indexer's cursor would live across cold starts.

The agent-kernel shape is the only one of these where the 0G removal test, the drain review, and the approval gate each map to one module.

## Implementation reconciliation

*Not started.*

## Open questions and risks

1. Which verifier does the Whitechain explorer use for `forge verify-contract`: Blockscout, or an Etherscan-compatible API? Confirm before the first deploy, because the deploy script depends on it.
2. Does `0x2642...26F7` enforce `msg.sender == to` in `receiveWithAuthorization`, as EIP-3009 requires? The fork test answers this, but only if it runs before the UI is built.
3. What does `transfer` return on the implementation at `0x2642...26F7`? The contract ignores the return value and relies on a revert. If the token returns `false` without reverting, the forward silently fails. Check it.
4. USDT decimals on `0xcedf...55a7` are assumed to be 6. Confirm with `decimals()` through Anon-RPC.
5. Does viem's `fetchFn` route through `AnonRpcWorker`, as `http({ fetchFn })` requires? If not, the `custom({ request })` fallback needs to be built. That is about an hour of work.
6. Does the Anon-RPC worker run in Node for the server indexer? If not, the server reads are direct, and the README must say so. That lowers the share number the EF judges will see.
7. Does the Ankr endpoint accept Tor exit traffic? It is untested. If it rejects, the second RPC is the fallback, and that one is also untested.
8. Private transcription with `x_0g_trace` is unverified on the audio endpoint, and only one private provider is known. If transcription fails in the demo, the voice flow is lost. Decide now whether the labeled typed-text path is acceptable, because it weakens the 0G "voice" story.
9. The relayer's gas price on 1874 is unknown. The daily cap and the breaker floor depend on one measured `settle` cost. Measure with one live transaction before setting either.
10. Payer funding. The demo client needs pre-funded official USDT, which means faucet WBT, then a YetiTrade swap. That is a one-hour task that blocks the payment demo. Start it first, in parallel with the contract.
11. The iAI bonus needs the 0G Privy sign-in and a credit balance that drops with use. This design does not include that flow. Add it only after the core flow works, and only on localhost ports 3000, 3001 or 5173.
12. The "return tomorrow" hook is a daily tick. A live demo shows a button, not a cron. Judges need to see a saved plan from a previous run, so the seeded data must include one.
13. Is a 2-of-2 approval rule (freelancer taps, then the reminder queues with a 10-minute undo) enough to keep the agent from sending a bad tone? That is a product call, and the demo should show it.
14. The EIP-3009 nonce is deterministic per invoice, payee and amount. Two valid signatures for the same invoice can therefore exist at once. Whichever lands first settles it, and both name the same payee and amount, so no money is at risk. Is a shared nonce acceptable for a v1 pay link, or should the client's signature include a random salt?

## Next implementation step

Write `contracts/src/InvoiceSettlement.sol` and its fork test against the official USDT, then run the deploy script on chain 1874 and verify the address on the Whitechain explorer before any UI code exists.

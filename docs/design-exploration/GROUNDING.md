# Grounding: "Paid" for ETHGlobal Mumbai (Nov 2026)

## User goal
A team (size undecided, 1-5) wants to win ETHGlobal Mumbai sponsor prizes plus the finalist prize. Greenfield: no existing code. The design must be buildable in an in-person ETHGlobal hackathon (~36 hours, typical ETHGlobal format) and demo reliably in under 3 minutes.

## Product (decided)
"Paid": Indian freelancer (designer/dev/writer) billing FOREIGN clients.
1. Freelancer records a voice note ("Invoice Acme, 3 logo drafts, $600").
2. Private AI (0G) transcribes + drafts a structured invoice; freelancer reviews/edits/sends.
3. Client gets a link, pays in USDT on Whitechain Sepolia with zero visible crypto steps and NO gas: signs once (EIP-3009) from an embedded/hidden wallet; Paid's relayer submits and pays gas.
4. Collections agent (the AI centerpiece, chosen to satisfy 0G "AI is the product, reason to return tomorrow"): daily "who owes you" view; drafts reminder emails/messages (Hinglish or English) whose tone escalates with lateness; reads client replies (pasted or forwarded) to update invoice status (e.g. "will pay Friday" -> promised date). Freelancer approves each send.
5. Freelancer dashboard: paid/pending/overdue totals; ALL chain reads go through Anon-RPC (Tor) by default.

## Sponsor tracks and hard rules (verbatim-derived from https://ethglobal.com/events/mumbai/prizes)
### 0G "Build with 0G Private Computer" ($2.5k/$1.5k/$1k)
- Consumer app where AI on 0G is the product; people open it and return tomorrow.
- Disqualified: generic chat wrappers; apps where the AI call could be removed without anyone noticing.
- Must show: inference on 0G Private Computer in main user flow WITH request IDs; a working app judges can try with a reason to come back tomorrow; one sentence on what breaks if 0G is removed.
- Bonus (iAI): user signs in with a 0G account (0G Privy app ID shared at event; ONLY works on localhost:3000, 3001 or 5173) and their credit balance drops as they use the app.
- Submission: public GitHub repo with README+setup, demo video < 3 min, live demo link, contract addresses, team contacts.
### EF "Best Use of Anon-RPC" ($2.5k/$1.5k/$1k). One EF prize per project.
- App must route its RPC reads through Anon-RPC BY DEFAULT.
- Judged on: works end to end in demo; UX quality; share of app's traffic through Anon-RPC; shippable after hackathon; technical depth. Excluding some traffic is OK if a deliberate, disclosed tradeoff.
### Whitechain "Scale · Payments Nobody Notices" ($2k/$1k)
- Payer (person or AI agent) pays stablecoins without holding WBT gas, managing a seed phrase, or knowing which chain.
- Judges want: payer flow with zero visible crypto steps in demo; how business pays gas, how relayer gets WBT, what prevents someone draining it.
- Won't place: payer signs a tx costing them gas; AI chats that never pay anyone.
- Must: contracts deployed on Whitechain Sepolia (chain 1874) and VERIFIED on Whitechain explorer; >=1 payment in official USDT 0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7 settled in main flow with explorer link in README (self-minted token doesn't count); README line on why onchain stablecoin settlement vs regular rail; public repo with steady commits; README setup/architecture/limitations; 2-4 min demo showing each party; WHITECHAIN_FEEDBACK.md.
- NOTE: a contract must be deployed and verified. So design needs at least one contract of our own (e.g. an InvoiceSettlement / relayer-forwarder contract), not only EOA relaying.
### ETHGlobal general
- Max 3 sponsor picks (implied). Finalist prize judged on overall quality.

## Verified integration facts (from research this session)
### 0G Private Computer (docs.0g.ai router)
- Base URL https://router-api.0g.ai/v1, OpenAI-compatible, auth `Authorization: Bearer sk-...`.
- Private mode: header `X-0G-Provider-Trust-Mode: private` (TeeML only: Intel TDX + TEE GPUs, dstack attestation, zero retention). If no TeeML provider: HTTP 503 `no_provider_for_trust_mode`, no silent fallback.
- Every response body: `x_0g_trace` with `request_id`, `provider`, `billing`. `verify_tee: true` (multipart: `?verify_tee=true`) adds `x_0g_trace.tee_verified`. Independent proof: `ZG-Res-Key` header + provider EIP-191 signature verifiable with SDK `processResponse`.
- `POST /v1/audio/transcriptions` (OpenAI multipart). Model id `whisper-large-v3` (docs example uses `openai/whisper-large-v3`); only 1 private provider -> availability risk. Unverified: private mode + x_0g_trace on the transcription endpoint.
- Private-capable LLMs: `glm-5.3`, `0gm-1.0-35b-a3b` (image input, tools, JSON). `tools` supported; `response_format` only `json_object` documented (json_schema unverified). Qwen vision/omni are TeeTLS, NOT private -> don't use.
- Every team gets 0G compute credits.
### Anon-RPC (github.com/ethereum/anon-rpc, ethereum.github.io/anon-rpc)
- Chain-agnostic: AnonRpcWorker gives an anonymized `fetch`; `worker.fetch(url)` reaches any HTTPS RPC.
  const worker = new AnonRpcWorker({ address: TOR_JS_SPECIFIER, config:{gateways:[...]}, preExisting:{ rpcProvider: mainnetProvider } });
  const client = createPublicClient({ chain: whitechainSepolia, transport: http(RPC_1874, { fetchFn: worker.fetch }) });  // viem fetchFn unverified; else custom({request})
- Bootstrap: one read on mainnet/Sepolia to resolve the specifier contract is NOT anonymized. tor-js has bootstrap delay; Nym bundle ~18MB; demo Tor gateway limited capacity. Ankr might reject Tor exits (untested). Writes would also pass through the worker if routed.
- RPCs for 1874: https://rpc.ankr.com/whitechain_testnet (worked w/o key, CORS *), https://rpc.testnet.whitechain.io (chainId 0x752).
- Est. 3-5h integration + 2h fallback/loading UX.
### Whitechain Sepolia (1874)
- Official USDT 0xcedf...55a7 = proxy -> TetherTokenV2 impl 0x2642...26F7 (verified). Supports EIP-2612 permit and EIP-3009 transferWithAuthorization + receiveWithAuthorization + cancelAuthorization + authorizationState. Domain: name "Tether USD", version "1", chainId 1874, verifyingContract = token; eip712Domain() reverts -> hardcode.
- Live proof of relayed EIP-3009: tx 0x23c28fd3557b1125f705c4499218327b9d894e715ac4d8e4ba8bdb7eee29d376 (84,429 gas).
- EntryPoint v0.6/0.7/0.8, Permit2, Multicall3 deployed. EIP-7702 likely (inferred). thirdweb bundler rejects 1874; no verified embedded-wallet provider for 1874 (Reown doesn't support).
- Faucet: https://faucet.testnet.whitechain.io 0.5 WBT/day, GitHub account >=30 days, IP-limited. USDT: swap WBT->USDT on YetiTrade pool 0x5645101C...F999 (testnet.yetitrade.fi) (inferred from chain data).
- Docs list a different testnet USDT.e 0xaa79...8f46 — DO NOT use; prize requires 0xcedf.
- No x402 docs on Whitechain.
### Payer-without-USDT reality
- A real foreign client may not hold USDT. Demo: client persona is a crypto startup/DAO that already pays contractors in USDT; demo wallet pre-funded. Design should keep an onramp seam but not build it.

## Constraints
- Secrets (0G API key, relayer private key) server-side only.
- Relayer drain prevention must be explainable on one slide.
- Payment settlement must be idempotent (client double-click, relayer retry, crash between submit and DB write).
- iAI sign-in only on localhost ports -> demo runs locally for 0G bonus; a hosted live link is also required for 0G submission.
- Keep demo deterministic: fallbacks must be honest (no faking AI or payments).

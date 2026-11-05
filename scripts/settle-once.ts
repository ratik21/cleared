/**
 * One real settlement from the command line.
 * The demo client signs, the relayer pays gas. Prints no keys.
 * Usage: bun scripts/settle-once.ts [amountUsdt] [payee]
 */
import { randomBytes } from "node:crypto";
import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  type Hex,
  http,
  parseSignature,
  toHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { clearedSettlementAbi } from "@/chain/abi.generated";
import { RECEIVE_WITH_AUTHORIZATION_TYPES } from "@/chain/eip3009";
import {
  SETTLEMENT,
  USDT,
  USDT_DOMAIN,
  whitechainSepolia,
} from "@/chain/whitechain";
import type { Address, InvoiceId, UsdtAtoms } from "@/domain/ids";
import { formatUsdt, parseUsdt } from "@/domain/money";
import { settleNonce } from "@/domain/settle-nonce";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name}`);
  }
  return value;
};

const value = parseUsdt(process.argv[2] ?? "5");
if (value === null) {
  throw new Error("Amount must be a plain USDT number, such as 5 or 5.50");
}
const payee = (process.argv[3] ?? required("RELAYER_ADDRESS")) as Address;
const rpc = http(required("RPC_1874"));
const payer = privateKeyToAccount(required("CLIENT_DEMO_PRIVATE_KEY") as Hex);
const relayer = privateKeyToAccount(required("RELAYER_PRIVATE_KEY") as Hex);

const chain = createPublicClient({ chain: whitechainSepolia, transport: rpc });
const wallet = createWalletClient({
  account: relayer,
  chain: whitechainSepolia,
  transport: rpc,
});

const balance = (await chain.readContract({
  abi: erc20Abi,
  address: USDT,
  args: [payer.address],
  functionName: "balanceOf",
})) as UsdtAtoms;
if (balance < value) {
  console.error(
    `${payer.address} holds ${formatUsdt(balance)} USDT and needs ${formatUsdt(value)}.`
  );
  process.exit(1);
}

const invoiceId = toHex(randomBytes(32)) as InvoiceId;
const validBefore = BigInt(Math.floor(Date.now() / 1000) + 3600);
const nonce = settleNonce({
  chainId: whitechainSepolia.id,
  invoiceId,
  payee,
  settlement: SETTLEMENT,
  value,
});
const signature = await payer.signTypedData({
  domain: USDT_DOMAIN,
  message: {
    from: payer.address,
    nonce,
    to: SETTLEMENT,
    validAfter: 0n,
    validBefore,
    value,
  },
  primaryType: "ReceiveWithAuthorization",
  types: RECEIVE_WITH_AUTHORIZATION_TYPES,
});
const { r, s, v, yParity } = parseSignature(signature);

const { request } = await chain.simulateContract({
  abi: clearedSettlementAbi,
  account: relayer,
  address: SETTLEMENT,
  args: [
    invoiceId,
    payer.address,
    payee,
    value,
    0n,
    validBefore,
    Number(v ?? BigInt(yParity + 27)),
    r,
    s,
  ],
  functionName: "settle",
});
const hash = await wallet.writeContract(request);
const receipt = await chain.waitForTransactionReceipt({ hash });

console.log(`status   ${receipt.status}`);
console.log(`invoice  ${invoiceId}`);
console.log(`gas      ${receipt.gasUsed}`);
console.log(`explorer https://explorer.testnet.whitechain.io/tx/${hash}`);

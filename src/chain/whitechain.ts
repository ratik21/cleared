import { defineChain } from "viem";
import type { Address } from "@/domain/ids";
import deployment from "../../deployments/1874.json";

export const whitechainSepolia = defineChain({
  blockExplorers: {
    default: {
      name: "Blockscout",
      url: "https://explorer.testnet.whitechain.io",
    },
  },
  id: 1874,
  name: "Whitechain Sepolia",
  nativeCurrency: { decimals: 18, name: "WBT", symbol: "WBT" },
  rpcUrls: { default: { http: ["https://rpc.testnet.whitechain.io/"] } },
});

export const RPC_BACKUP = "https://rpc.ankr.com/whitechain_testnet";
export const SETTLEMENT = deployment.settlement as Address;
export const USDT = deployment.usdt as Address;

/** Hardcoded because `eip712Domain()` reverts on the token. Matches its on-chain DOMAIN_SEPARATOR. */
export const USDT_DOMAIN = {
  chainId: whitechainSepolia.id,
  name: "Tether USD",
  verifyingContract: USDT,
  version: "1",
} as const;

import {
  encodeAbiParameters,
  type Hex,
  keccak256,
  pad,
  stringToHex,
} from "viem";
import type { Address, InvoiceId, UsdtAtoms } from "./ids";

const SETTLE_VERSION = pad(stringToHex("CLEARED_SETTLE_V1"), {
  dir: "right",
  size: 32,
});

const NONCE_PARAMS = [
  { type: "bytes32" },
  { type: "uint256" },
  { type: "address" },
  { type: "bytes32" },
  { type: "address" },
  { type: "uint256" },
] as const;

export interface SettleTerms {
  chainId: number;
  invoiceId: InvoiceId;
  payee: Address;
  settlement: Address;
  value: UsdtAtoms;
}

/** The EIP-3009 nonce the payer signs. Must match `nonceFor` in ClearedSettlement.sol. */
export const settleNonce = (terms: SettleTerms): Hex =>
  keccak256(
    encodeAbiParameters(NONCE_PARAMS, [
      SETTLE_VERSION,
      BigInt(terms.chainId),
      terms.settlement,
      terms.invoiceId,
      terms.payee,
      terms.value,
    ])
  );

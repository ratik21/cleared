import { formatUnits, parseUnits } from "viem";
import type { UsdtAtoms } from "./ids";

const USDT_DECIMALS = 6;
const AMOUNT_PATTERN = /^\d+(?:\.\d{1,6})?$/u;

// Mirrors the constants in ClearedSettlement.sol.
const FEE_BPS = 50n;
const FEE_CAP = 2_000_000n;
export const MIN_VALUE = 5_000_000n as UsdtAtoms;

export const parseUsdt = (text: string): UsdtAtoms | null =>
  AMOUNT_PATTERN.test(text)
    ? (parseUnits(text, USDT_DECIMALS) as UsdtAtoms)
    : null;

export const formatUsdt = (atoms: UsdtAtoms): string =>
  formatUnits(atoms, USDT_DECIMALS);

export const feeFor = (value: UsdtAtoms): UsdtAtoms => {
  const fee = (value * FEE_BPS) / 10_000n;
  return (fee > FEE_CAP ? FEE_CAP : fee) as UsdtAtoms;
};

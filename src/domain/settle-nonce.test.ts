import { describe, expect, test } from "bun:test";
import vectors from "../../vectors/nonce.json";
import type { Address, InvoiceId, UsdtAtoms } from "./ids";
import { settleNonce } from "./settle-nonce";

describe("settleNonce", () => {
  test.each(vectors.cases.map((c) => [c.label, c] as const))(
    "matches the golden vector: %s",
    (_label, c) => {
      expect(
        settleNonce({
          chainId: Number(c.chainId),
          invoiceId: c.invoiceId as InvoiceId,
          payee: c.payee as Address,
          settlement: c.settlement as Address,
          value: BigInt(c.value) as UsdtAtoms,
        })
      ).toBe(c.nonce as `0x${string}`);
    }
  );
});

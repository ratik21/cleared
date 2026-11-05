import { describe, expect, test } from "bun:test";
import { canMove } from "./attempt";
import type { Address, InvoiceId, PayToken, UsdtAtoms } from "./ids";
import { deriveState, type InvoiceRecord, totalOf } from "./invoice";
import { daysLate, tierFor } from "./lateness";
import { feeFor, formatUsdt, parseUsdt } from "./money";

const atoms = (value: bigint) => value as UsdtAtoms;

const open: InvoiceRecord = {
  amount: atoms(600_000_000n),
  client: { lang: "en", name: "Acme" },
  dueAt: "2026-11-10T00:00:00.000Z",
  id: "0x01" as InvoiceId,
  items: [],
  kind: "open",
  payee: "0x02" as Address,
  sentAt: "2026-11-03T00:00:00.000Z",
  token: "secret" as PayToken,
};
const beforeDue = new Date("2026-11-09T12:00:00.000Z");
const afterDue = new Date("2026-11-12T12:00:00.000Z");

describe("deriveState", () => {
  test("draft and void come straight from the record", () => {
    const voided: InvoiceRecord = {
      id: open.id,
      kind: "void",
      voidedAt: "2026-11-04T00:00:00.000Z",
    };
    expect(deriveState(voided, [], afterDue)).toBe("void");
  });

  test("open until due, overdue after", () => {
    expect(deriveState(open, [], beforeDue)).toBe("open");
    expect(deriveState(open, [], afterDue)).toBe("overdue");
  });

  test("a live attempt is paying, even when past due", () => {
    expect(deriveState(open, [{ state: "queued" }], afterDue)).toBe("paying");
    expect(deriveState(open, [{ state: "broadcast" }], afterDue)).toBe(
      "paying"
    );
  });

  test("only a confirmed attempt is paid", () => {
    expect(
      deriveState(open, [{ state: "failed" }, { state: "confirmed" }], afterDue)
    ).toBe("paid");
  });

  test("failed and expired attempts leave the invoice unpaid", () => {
    expect(
      deriveState(open, [{ state: "failed" }, { state: "expired" }], afterDue)
    ).toBe("overdue");
  });

  test("a promise holds through its whole day, then lapses to overdue", () => {
    expect(deriveState(open, [], afterDue, "2026-11-12")).toBe("promised");
    expect(deriveState(open, [], afterDue, "2026-11-11")).toBe("overdue");
  });

  test("a confirmed payment beats a promise", () => {
    expect(
      deriveState(open, [{ state: "confirmed" }], afterDue, "2026-11-20")
    ).toBe("paid");
  });
});

describe("attempt moves", () => {
  test("final states never move", () => {
    expect(canMove("confirmed", "broadcast")).toBe(false);
    expect(canMove("failed", "queued")).toBe(false);
    expect(canMove("expired", "confirmed")).toBe(false);
  });

  test("preflight can confirm a queued attempt", () => {
    expect(canMove("queued", "confirmed")).toBe(true);
  });

  test("a fee bump stays in broadcast", () => {
    expect(canMove("broadcast", "broadcast")).toBe(true);
  });
});

describe("tierFor", () => {
  test.each([
    [0, "friendly"],
    [6, "friendly"],
    [7, "firm"],
    [13, "firm"],
    [14, "final"],
  ] as const)("%i days late is %s", (days, tier) => {
    expect(tierFor(days)).toBe(tier);
  });

  test("daysLate never goes negative", () => {
    expect(daysLate("2026-11-10T00:00:00.000Z", beforeDue)).toBe(0);
    expect(daysLate("2026-11-10T00:00:00.000Z", afterDue)).toBe(2);
  });
});

describe("money", () => {
  test("parses exact amounts without floats", () => {
    expect(parseUsdt("49.00")).toBe(atoms(49_000_000n));
    expect(parseUsdt("0.000001")).toBe(atoms(1n));
  });

  test("rejects malformed amounts", () => {
    for (const bad of ["", "-1", "1.1234567", "1e3", "abc"]) {
      expect(parseUsdt(bad)).toBeNull();
    }
  });

  test("formats atoms", () => {
    expect(formatUsdt(atoms(49_500_000n))).toBe("49.5");
  });

  test("fee is 0.5%, capped at 2 USDT, matching the contract", () => {
    expect(feeFor(atoms(100_000_000n))).toBe(atoms(500_000n));
    expect(feeFor(atoms(600_000_000n))).toBe(atoms(2_000_000n));
  });

  test("totals line items in code", () => {
    expect(
      totalOf([
        { description: "Logo", quantity: 3, unitPrice: atoms(200_000_000n) },
      ])
    ).toBe(atoms(600_000_000n));
  });
});

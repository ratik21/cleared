import type { AttemptState } from "./attempt";
import type { Address, InvoiceId, PayToken, UsdtAtoms } from "./ids";

export interface Client {
  email?: string;
  lang: "en" | "es";
  name: string;
  whatsapp?: string;
}

export interface LineItem {
  description: string;
  quantity: number;
  unitPrice: UsdtAtoms;
}

export type InvoiceRecord =
  | {
      kind: "draft";
      id: InvoiceId;
      client: Client;
      items: LineItem[];
      dueAt: string;
    }
  | {
      kind: "open";
      id: InvoiceId;
      client: Client;
      items: LineItem[];
      dueAt: string;
      payee: Address;
      amount: UsdtAtoms;
      token: PayToken;
      sentAt: string;
    }
  | { kind: "void"; id: InvoiceId; voidedAt: string };

export type InvoiceState =
  | "draft"
  | "open"
  | "overdue"
  | "promised"
  | "paying"
  | "paid"
  | "void";

const isoDay = (date: Date) => date.toISOString().slice(0, 10);

/** Payment status is never stored. `paid` needs a confirmed attempt, which only chain evidence writes. */
export const deriveState = (
  record: InvoiceRecord,
  attempts: readonly { state: AttemptState }[],
  now: Date,
  promisedDate?: string
): InvoiceState => {
  if (record.kind !== "open") {
    return record.kind;
  }
  if (attempts.some((attempt) => attempt.state === "confirmed")) {
    return "paid";
  }
  if (
    attempts.some(
      (attempt) => attempt.state === "queued" || attempt.state === "broadcast"
    )
  ) {
    return "paying";
  }
  if (promisedDate) {
    return promisedDate.slice(0, 10) >= isoDay(now) ? "promised" : "overdue";
  }
  return now.getTime() > Date.parse(record.dueAt) ? "overdue" : "open";
};

/** The model returns quantities and unit prices. Code does the sum. */
export const totalOf = (items: readonly LineItem[]): UsdtAtoms =>
  items.reduce(
    (sum, item) => sum + BigInt(item.quantity) * item.unitPrice,
    0n
  ) as UsdtAtoms;

export type Brand<T, B extends string> = T & { readonly __brand: B };

/** bytes32, also the on-chain key. Public: it appears in `InvoiceSettled`. */
export type InvoiceId = Brand<`0x${string}`, "InvoiceId">;
/** Secret in the pay link, never on chain. */
export type PayToken = Brand<string, "PayToken">;
export type Address = Brand<`0x${string}`, "Address">;
/** USDT has 6 decimals. Always a bigint, never a float. */
export type UsdtAtoms = Brand<bigint, "UsdtAtoms">;
/** 0G `x_0g_trace.request_id`. */
export type ZgRequestId = Brand<string, "ZgRequestId">;

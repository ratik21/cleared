import "server-only";
import { z } from "zod";

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/u);
const privateKey = z.string().regex(/^0x[0-9a-fA-F]{64}$/u);

const schema = z.object({
  AUTH_MODE: z.enum(["privy", "demo"]),
  CLEARED_API_KEY: z.string().min(1),
  DAILY_GAS_BUDGET_WEI: z.coerce.bigint().positive(),
  DATABASE_PATH: z.string().min(1),
  EXPLORER_API: z.url(),
  NEXT_PUBLIC_PRIVY_APP_ID: z.string().default(""),
  RELAYER_PRIVATE_KEY: privateKey,
  RPC_1874: z.url(),
  RPC_1874_BACKUP: z.url(),
  TREASURY_ADDRESS: address,
  USDT_ADDRESS: address,
  ZG_API_KEY: z.string().min(1),
});

export type Env = z.infer<typeof schema>;

let parsed: Env | undefined;

/** Parses on first call. `instrumentation.ts` calls it at boot, so bad config stops the server. */
export const getEnv = (): Env => {
  if (parsed) {
    return parsed;
  }
  const result = schema.safeParse(process.env);
  if (!result.success) {
    // Names and rule messages only: zod's issue paths never include the value.
    const problems = result.error.issues.map(
      (issue) => `${issue.path.join(".")}: ${issue.message}`
    );
    throw new Error(`Invalid environment:\n${problems.join("\n")}`);
  }
  parsed = result.data;
  return parsed;
};

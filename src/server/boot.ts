import { getEnv } from "@/env";

/** Runs once at server start, on the Node runtime only. */
export const boot = () => {
  try {
    getEnv();
  } catch (error) {
    // Next only logs a failed register() and serves 500s, so exit explicitly.
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
};

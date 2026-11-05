export const register = async () => {
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }
  const { getEnv } = await import("@/env");
  try {
    getEnv();
  } catch (error) {
    // Next only logs a failed register() and serves 500s, so exit explicitly.
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
};

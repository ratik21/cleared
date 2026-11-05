export const register = async () => {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { boot } = await import("@/server/boot");
    boot();
  }
};

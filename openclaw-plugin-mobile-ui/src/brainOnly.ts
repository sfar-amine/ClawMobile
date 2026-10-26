/** Deployment owner only. Client DTOs and model arguments never select this path. */
export function brainOnlyEnabled(): boolean {
  return process.env.SAMANTHA_BRAIN_ONLY === "1";
}

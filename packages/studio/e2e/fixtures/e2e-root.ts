export const E2E_PROJECT_ROOT = process.env.INKOS_E2E_PROJECT_ROOT?.trim();

if (!E2E_PROJECT_ROOT) {
  throw new Error("INKOS_E2E_PROJECT_ROOT is required for Studio E2E fixtures.");
}

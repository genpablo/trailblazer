import { languages } from "@traiblazer/i18n";
import { availablePacks, packs } from "@traiblazer/industry-packs";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";

/** Read-only reference data for the admin portal (industry packs, languages). */
export async function catalogRoutes(app: FastifyInstance, { platform }: AppContext) {
  app.get("/v1/catalog/packs", async () => {
    // Which rollout phase is released is an operator policy.
    const available = availablePacks((await platform!.policies()).releasedPackPhase);
    return {
      available,
      upcoming: packs
        .filter((p) => !available.includes(p))
        .map(({ slug, name, sector, phase }) => ({ slug, name, sector, phase })),
    };
  });

  app.get("/v1/catalog/languages", async () => ({ languages }));
}

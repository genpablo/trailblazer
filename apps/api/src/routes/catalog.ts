import { languages } from "@traiblazer/i18n";
import { availablePacks, packs } from "@traiblazer/industry-packs";
import type { FastifyInstance } from "fastify";

/** Read-only reference data for the admin portal (industry packs, languages). */
export async function catalogRoutes(app: FastifyInstance) {
  app.get("/v1/catalog/packs", async () => ({
    available: availablePacks(),
    upcoming: packs
      .filter((p) => !availablePacks().includes(p))
      .map(({ slug, name, sector, phase }) => ({ slug, name, sector, phase })),
  }));

  app.get("/v1/catalog/languages", async () => ({ languages }));
}

import { createHash } from "node:crypto";
import { assets, getPublicAsset, withTenant } from "@traiblazer/db";
import { assetUploadSchema, MAX_ASSET_BYTES } from "@traiblazer/shared";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { badRequest, notFound } from "../lib/errors.js";
import { sniffImageType } from "../lib/images.js";
import { requireTenantRole } from "../plugins/auth.js";

export const publicAssetUrl = (publicUrl: string, id: string) => `${publicUrl}/v1/public/assets/${id}`;

/** Image uploads (assistant avatars) and their public, cacheable delivery. */
export async function assetRoutes(app: FastifyInstance, { db, config }: AppContext) {
  app.post<{ Params: { tenantId: string } }>(
    "/v1/tenants/:tenantId/assets",
    { preHandler: requireTenantRole(db, "editor"), bodyLimit: 1024 * 1024 },
    async (request, reply) => {
      const input = assetUploadSchema.parse(request.body);
      const bytes = Buffer.from(input.data, "base64");
      if (!bytes.length || bytes.length > MAX_ASSET_BYTES) {
        throw badRequest("Images must be smaller than 512 KB");
      }
      const contentType = sniffImageType(bytes);
      if (!contentType) throw badRequest("Please upload a PNG, JPEG or WebP image");

      const tenantId = request.tenant!.id;
      const [row] = await withTenant(db, tenantId, (tx) =>
        tx
          .insert(assets)
          .values({
            tenantId,
            kind: input.kind,
            contentType,
            bytes,
            sizeBytes: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          })
          .returning({ id: assets.id }),
      );
      return reply
        .code(201)
        .send({ asset: { id: row!.id, url: publicAssetUrl(config.PUBLIC_URL, row!.id) } });
    },
  );

  app.get<{ Params: { id: string } }>("/v1/public/assets/:id", async (request, reply) => {
    const asset = await getPublicAsset(db, request.params.id);
    if (!asset) throw notFound("Image");
    return reply
      .type(asset.contentType)
      .header("cache-control", "public, max-age=31536000, immutable")
      .header("etag", `"${asset.sha256}"`)
      .header("x-content-type-options", "nosniff")
      .header("content-security-policy", "default-src 'none'; sandbox")
      .header("cross-origin-resource-policy", "cross-origin")
      .send(asset.bytes);
  });
}

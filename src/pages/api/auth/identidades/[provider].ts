import type { APIRoute } from "astro";
import { and, eq } from "drizzle-orm";
import { oauthIdentities } from "../../../../../drizzle/schema";
import { createDb } from "../../../../lib/db";
import { isValidProvider } from "../../../../lib/auth/providers";
import { revocarAcceso } from "../../../../lib/auth/revoke";
import { leerTokenOpcional } from "../../../../lib/auth/token-store";
import { withApi } from "../../../../lib/observability/with-api";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// Desvincula un proveedor de la cuenta con sesión (docs/18 D9). Se rechaza si es la última identidad
// o la del calendario activo (cambiar de calendario queda fuera de esta versión, §11 del TDD).
export const DELETE: APIRoute = withApi(async ({ params, locals }) => {
  const user = locals.user;
  if (!user) return json({ error: "Unauthorized" }, 401);

  const env = locals.runtime.env;

  const { provider } = params;
  if (!provider || !isValidProvider(provider)) return json({ error: "Provider not supported" }, 400);

  const db = createDb(env.DB);
  const identidades = await db.query.oauthIdentities.findMany({ where: eq(oauthIdentities.userId, user.id) });
  const identidad = identidades.find((i) => i.provider === provider);
  if (!identidad) return json({ error: "identidad_no_encontrada" }, 404);
  if (identidades.length <= 1) return json({ error: "ultima_identidad" }, 409);
  if (user.provider === provider) return json({ error: "identidad_activa" }, 409);

  await db.delete(oauthIdentities).where(and(eq(oauthIdentities.id, identidad.id), eq(oauthIdentities.userId, user.id)));

  // Después de D1: si falla, la identidad ya no existe y el token no quedó guardado en ningún lado
  const refreshToken = await leerTokenOpcional(env, identidad.refreshToken, identidad.id, "refresh_token");
  await revocarAcceso(env, { provider, refreshToken }, locals.logger);

  locals.logger?.info("identity_unlinked", { provider });
  return json({ ok: true });
});

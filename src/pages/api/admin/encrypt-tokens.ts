import type { APIRoute } from "astro";
import { createDb } from "../../../lib/db";
import { isAdminAuthorized, unauthorized } from "../../../lib/observability/admin-auth";
import { withApi } from "../../../lib/observability/with-api";
import { claveValida } from "../../../lib/auth/token-crypto";
import { procesarTokens, type Direccion } from "../../../lib/auth/token-backfill";

// Backfill del cifrado de tokens (docs/15 D5). Bearer ADMIN_SECRET. Cada llamada procesa un lote acotado:
// repetir hasta que `pendientes` sea 0. Idempotente. `?direction=decrypt` devuelve las filas a texto plano
// y existe solo para el rollback del Release A (se corre antes de revertir el código).
export const POST: APIRoute = withApi(async ({ request, url, locals }) => {
  const env = locals.runtime.env;
  if (!isAdminAuthorized(request, env.ADMIN_SECRET)) return unauthorized();

  const direccion: Direccion = url.searchParams.get("direction") === "decrypt" ? "decrypt" : "encrypt";
  const headers = { "Cache-Control": "no-store" };

  // Sin clave no se puede cifrar ni descifrar: se corta antes de tocar la base
  if (!claveValida(env)) {
    locals.logger?.error("token_key_missing", { origen: "backfill" });
    return Response.json({ error: "token_key_missing" }, { status: 503, headers });
  }

  const resultado = await procesarTokens(env, createDb(env.DB), direccion);
  // Solo conteos: nunca tokens (docs/15 K15)
  locals.logger?.info("token_backfill", { ...resultado });
  return Response.json(resultado, { headers });
});

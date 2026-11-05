import type { APIRoute } from "astro";
import { createDb } from "../../../lib/db";
import { isAdminAuthorized, unauthorized } from "../../../lib/observability/admin-auth";
import { withApi } from "../../../lib/observability/with-api";
import { claveValida, clavePreviaValida } from "../../../lib/auth/token-crypto";
import { CursorInvalidoError, procesarTokens, type Direccion } from "../../../lib/auth/token-backfill";

// Backfill del cifrado de tokens (docs/15 D5). Bearer ADMIN_SECRET. Cada llamada procesa un lote acotado de filas:
// repetir con `?cursor=<siguienteCursor>` hasta que `siguienteCursor` sea null y `pendientes` 0. Idempotente.
// `?direction=decrypt` devuelve las filas a texto plano y existe solo para el rollback del Release A, que
// necesita una ventana de mantenimiento (docs/23).
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
  // Una clave anterior mal formada rompería la lectura de las filas: se avisa antes de tocar la base
  if (!clavePreviaValida(env)) {
    locals.logger?.error("token_key_previous_invalid", { origen: "backfill" });
    return Response.json({ error: "token_key_previous_invalid" }, { status: 503, headers });
  }

  let resultado;
  try {
    resultado = await procesarTokens(env, createDb(env.DB), direccion, url.searchParams.get("cursor"));
  } catch (error) {
    if (error instanceof CursorInvalidoError) return Response.json({ error: "cursor_invalido" }, { status: 400, headers });
    throw error;
  }
  // Solo conteos y cursores: nunca tokens (docs/15 K15)
  locals.logger?.info("token_backfill", { ...resultado });
  return Response.json(resultado, { headers });
});

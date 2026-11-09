import type { APIRoute } from "astro";
import { createDb } from "../../../lib/db";
import { verificarAdmin } from "../../../lib/observability/admin-auth";
import { withApi } from "../../../lib/observability/with-api";
import { claveValida, clavePreviaValida } from "../../../lib/auth/token-crypto";
import { CursorInvalidoError, procesarTokens, type Direccion } from "../../../lib/auth/token-backfill";

// Backfill del cifrado de tokens (docs/15 D5). Bearer ADMIN_SECRET. Cada llamada procesa un lote acotado de filas:
// repetir con `?cursor=<siguienteCursor>` hasta que `siguienteCursor` sea null y `pendientes` 0. Idempotente.
// `?direction=decrypt` devuelve las filas a texto plano y existe solo para el rollback del Release A, que
// necesita una ventana de mantenimiento (docs/23). Desde el Release B el código ya no lee texto plano: decrypt
// responde 409 salvo con `&confirmar=release-b-revertido`, que se pasa solo con el Release B ya revertido (docs/15 §9).
const CONFIRMAR_DECRYPT = "release-b-revertido";
export const POST: APIRoute = withApi(async ({ request, url, locals }) => {
  const env = locals.runtime.env;
  const rechazo = await verificarAdmin(request, env, { logger: locals.logger, requestId: locals.requestId });
  if (rechazo) return rechazo;

  const direccion: Direccion = url.searchParams.get("direction") === "decrypt" ? "decrypt" : "encrypt";
  const headers = { "Cache-Control": "no-store" };

  // Antes de mirar la clave o la base: con el Release B desplegado, el texto plano que escribe decrypt es ilegible
  if (direccion === "decrypt" && url.searchParams.get("confirmar") !== CONFIRMAR_DECRYPT) {
    locals.logger?.warn("token_decrypt_rechazado", { origen: "backfill" });
    return Response.json({ error: "decrypt_requiere_release_a" }, { status: 409, headers });
  }

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
}, { origin: "none", contentType: "any", rateLimit: [] });

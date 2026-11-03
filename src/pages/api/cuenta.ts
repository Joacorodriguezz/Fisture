import type { APIRoute } from "astro";
import { eq } from "drizzle-orm";
import { oauthIdentities } from "../../../drizzle/schema";
import { createDb } from "../../lib/db";
import { deleteAccount } from "../../lib/db/account";
import { esMismoOrigen } from "../../lib/auth/guards";
import { revocarAcceso } from "../../lib/auth/revoke";
import { withApi } from "../../lib/observability/with-api";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Elimina la cuenta del usuario con sesión (docs/14-borrado-de-cuenta-tdd.md).
// Cuerpo: { "confirmar": "<email>" }, debe coincidir con el email de la cuenta.
export const DELETE: APIRoute = withApi(async ({ request, cookies, locals }) => {
  const user = locals.user;
  if (!user) return json({ error: "Unauthorized" }, 401);

  // El usuario va a dejar de existir: ningún log de este request debe llevar su userId (D9)
  locals.omitirUserIdEnLog = true;

  const env = locals.runtime.env;
  if (!esMismoOrigen(request, env)) return json({ error: "Origen no permitido" }, 403);
  if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) {
    return json({ error: "Content-Type debe ser application/json" }, 415);
  }

  const body = (await request.json().catch(() => null)) as { confirmar?: unknown } | null;
  if (typeof body?.confirmar !== "string") return json({ error: "Falta la confirmación" }, 400);
  if (body.confirmar.trim().toLowerCase() !== user.email.toLowerCase()) {
    return json({ error: "La confirmación no coincide con el email de la cuenta" }, 400);
  }

  // Los accesos a revocar se leen antes: las identidades caen por cascada junto con el usuario (docs/18 V-22).
  // Sin identidades (usuario legado) se usa el refresh token de users.*
  const identidades = await createDb(env.DB).select({ provider: oauthIdentities.provider, refreshToken: oauthIdentities.refreshToken }).from(oauthIdentities).where(eq(oauthIdentities.userId, user.id));
  const accesos = identidades.length > 0 ? identidades : [{ provider: user.provider, refreshToken: user.refreshToken }];

  const filas = await deleteAccount(env.DB, user.id);

  // Las sesiones del usuario cayeron por cascada junto con el resto de sus filas (docs/21 D3)
  cookies.delete("session", { path: "/" });

  // Después de D1 (D5): si esto falla el usuario ya está borrado y el token no quedó guardado en ningún lado
  for (const acceso of accesos) await revocarAcceso(env, acceso, locals.logger);

  // Ni el email ni el userId van al log (D9)
  locals.logger?.info("account_deleted", { provider: user.provider, rows: filas });

  return json({ ok: true });
});

import type { APIRoute } from "astro";
import { deleteAccount } from "../../lib/db/account";
import { deleteSession } from "../../lib/auth/session";
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

  const body = (await request.json().catch(() => null)) as { confirmar?: unknown } | null;
  if (typeof body?.confirmar !== "string") return json({ error: "Falta la confirmación" }, 400);
  if (body.confirmar.trim().toLowerCase() !== user.email.toLowerCase()) {
    return json({ error: "La confirmación no coincide con el email de la cuenta" }, 400);
  }

  const env = locals.runtime.env;
  const filas = await deleteAccount(env.DB, user.id);

  const sessionId = cookies.get("session")?.value;
  if (sessionId) await deleteSession(env.KV, sessionId);
  cookies.delete("session", { path: "/" });

  // Ni el email ni el userId van al log (D9): withApi agrega el userId del request si hay usuario
  locals.logger?.info("account_deleted", { provider: user.provider, rows: filas });
  delete locals.user;

  return json({ ok: true });
});

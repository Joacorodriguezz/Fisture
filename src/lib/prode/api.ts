// Respuestas de los endpoints del prode (docs/37 §3.4): JSON sin caché y errores con un código estable
// que la UI traduce a un mensaje.
export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export function error(codigo: string, status: number, extra: Record<string, unknown> = {}): Response {
  return json({ error: codigo, ...extra }, status);
}

export const sinSesion = () => error("Unauthorized", 401);

// Estado HTTP de cada error de administración de grupos
const ESTADOS: Record<string, number> = { no_miembro: 404, no_admin: 403, es_vos: 400 };

export function errorDeGrupo(codigo: string): Response {
  return error(codigo, ESTADOS[codigo] ?? 400);
}

export async function leerJson(request: Request): Promise<unknown> {
  return request.json().catch(() => undefined);
}

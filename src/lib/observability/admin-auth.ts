// Autorización de los endpoints /api/admin/*: Authorization: Bearer <ADMIN_SECRET>
function iguales(a: string, b: string): boolean {
  // Comparación en tiempo constante respecto del contenido
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

export function isAdminAuthorized(request: Request, adminSecret?: string): boolean {
  if (!adminSecret) return false;
  const header = request.headers.get("Authorization") ?? "";
  return iguales(header, `Bearer ${adminSecret}`);
}

export function unauthorized(): Response {
  return Response.json({ error: "Unauthorized" }, { status: 401 });
}

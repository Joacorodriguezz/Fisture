import type { APIRoute } from "astro";
import { getHealth } from "../../lib/observability/health";
import { withApi } from "../../lib/observability/with-api";

// Público: solo estados y la fecha del último sync exitoso, sin errores ni nombres internos.
// 200 si todo está ok o degradado; 503 si algún check falla.
export const GET: APIRoute = withApi(async ({ locals }) => {
  const health = await getHealth(locals.runtime.env);
  return Response.json(health, {
    status: health.status === "fail" ? 503 : 200,
    headers: { "Cache-Control": "no-store" },
  });
});

import type { APIRoute } from "astro";
import { deleteSession } from "../../../lib/auth/session";
import { withApi } from "../../../lib/observability/with-api";

export const GET: APIRoute = withApi(async ({ cookies, redirect, locals }) => {
  const sessionId = cookies.get("session")?.value;

  if (sessionId) {
    await deleteSession(locals.runtime.env.KV, sessionId);
  }

  cookies.delete("session", { path: "/" });
  return redirect("/");
});

import type { APIRoute } from "astro";
import { createDb } from "../../../lib/db";
import { deleteSession } from "../../../lib/auth/session";
import { withApi } from "../../../lib/observability/with-api";

export const GET: APIRoute = withApi(async ({ cookies, redirect, locals }) => {
  const sessionId = cookies.get("session")?.value;

  if (sessionId) {
    await deleteSession(createDb(locals.runtime.env.DB), sessionId);
  }

  cookies.delete("session", { path: "/" });
  return redirect("/");
});

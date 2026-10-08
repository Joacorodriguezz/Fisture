import type { APIRoute } from "astro";
import { deleteSession } from "../../../lib/auth/session";

export const GET: APIRoute = async ({ cookies, redirect, locals }) => {
  const sessionId = cookies.get("session")?.value;

  if (sessionId) {
    await deleteSession(locals.runtime.env.KV, sessionId);
  }

  cookies.delete("session", { path: "/" });
  return redirect("/");
};

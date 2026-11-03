import type { APIRoute } from "astro";
import { isValidProvider } from "../../../../lib/auth/providers";
import { leerEstado, nombreCookieEstado } from "../../../../lib/auth/oauth-state";
import { createSession } from "../../../../lib/auth/session";
import { createDb } from "../../../../lib/db";
import { withApi } from "../../../../lib/observability/with-api";
import { safeNext } from "../../../../lib/auth/guards";
import { obtenerIdentidad } from "../../../../lib/auth/perfil";
import {
  agregarIdentidad,
  buscarIdentidad,
  buscarIdentidadDeUsuario,
  buscarUsuario,
  buscarUsuarioLegado,
  buscarUsuarioPorEmail,
  crearIdentidadLegada,
  crearUsuarioConIdentidad,
  decidirVinculo,
  registrarLogin,
} from "../../../../lib/auth/identity";

// Quién es el usuario lo decide (provider, provider_id) y nunca el email (docs/18).
// El email solo sirve para unir una cuenta nueva a una existente cuando ambos lados están verificados.
export const GET: APIRoute = withApi(async ({ params, url, redirect, cookies, locals }) => {
  const { provider } = params;
  const env = locals.runtime.env;

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code || !state) {
    return redirect("/login?error=missing_params");
  }

  if (!provider || !isValidProvider(provider)) {
    return redirect("/login?error=unsupported_provider");
  }

  if (!env.OAUTH_STATE_SECRET) {
    locals.logger?.error("oauth_state_secret_missing", { provider });
    return redirect("/login?error=oauth_unavailable");
  }

  const nombreCookie = nombreCookieEstado(provider);
  const estado = await leerEstado(env.OAUTH_STATE_SECRET, cookies.get(nombreCookie)?.value, { state, provider });
  // Se borra siempre: un intento se consume tenga éxito o no el intercambio del code
  cookies.delete(nombreCookie, { path: "/api/auth" });
  if (!estado) {
    return redirect("/login?error=invalid_state");
  }

  const { codeVerifier, next } = estado;

  // Vincular exige la sesión vigente del mismo usuario que inició el intento (V-10)
  if (estado.intent === "link") {
    if (!locals.user) return redirect("/login?error=vinculo_sesion");
    if (locals.user.id !== estado.userId) return redirect("/configuracion?error=vinculo_sesion");
  }

  try {
    const { perfil, tokens } = await obtenerIdentidad(env, provider, code, codeVerifier);
    const db = createDb(env.DB);
    // El proveedor de la URL es el del intento actual. Nunca el de la otra cuenta: no se revela (email_en_uso)
    const conflicto = (codigo: string, destino: string, proveedor?: string) => {
      locals.logger?.warn("oauth_identity_conflict", { provider, code: codigo });
      return redirect(`${destino}?error=${codigo}${proveedor ? `&proveedor=${proveedor}` : ""}`);
    };

    // ---------- Vincular desde Configuración ----------
    if (estado.intent === "link") {
      const userId = estado.userId!;
      const existente = await buscarIdentidad(db, provider, perfil.providerId);
      if (existente && existente.userId !== userId) return conflicto("identidad_en_uso", "/configuracion", provider);

      if (existente) {
        const dueno = await buscarUsuario(db, userId);
        if (!dueno) return redirect("/login?error=vinculo_sesion");
        await registrarLogin(db, existente, dueno, perfil, tokens);
      } else {
        // En esta versión hay una identidad por proveedor y usuario
        if (await buscarIdentidadDeUsuario(db, userId, provider)) return conflicto("proveedor_en_uso", "/configuracion", provider);
        await agregarIdentidad(db, userId, perfil, tokens);
      }
      return redirect(`/configuracion?vinculado=${provider}`);
    }

    // ---------- Login ----------
    let userId: string;
    const identidad = await buscarIdentidad(db, provider, perfil.providerId);

    if (identidad) {
      userId = identidad.userId;
      const dueno = await buscarUsuario(db, userId);
      if (!dueno) throw new Error("identity_without_user");
      await registrarLogin(db, identidad, dueno, perfil, tokens);
    } else {
      const legado = await buscarUsuarioLegado(db, provider, perfil.providerId);
      if (legado) {
        userId = legado.id;
        const creada = await crearIdentidadLegada(db, legado, perfil, tokens);
        await registrarLogin(db, creada, legado, perfil, tokens);
      } else {
        // Sin email no hay con qué decidir si ya existe una cuenta: no se crea nada
        if (!perfil.email) return conflicto("email_ausente", "/login", provider);

        const cuenta = (await buscarUsuarioPorEmail(db, perfil.email)) ?? null;
        const decision = decidirVinculo({
          identidadExistente: false,
          identidadVerificada: perfil.emailVerified,
          cuenta,
          autoVincular: env.AUTO_VINCULAR_EMAIL_VERIFICADO === "true",
        });

        if (decision === "crear") {
          userId = await crearUsuarioConIdentidad(db, perfil, tokens);
        } else if (decision === "vincular" && cuenta && !(await buscarIdentidadDeUsuario(db, cuenta.id, provider))) {
          userId = cuenta.id;
          await agregarIdentidad(db, userId, perfil, tokens);
        } else {
          // Hay una cuenta con ese email y no se puede unir sola: no se abre sesión ni se toca nada
          return conflicto("email_en_uso", "/login");
        }
      }
    }

    const sessionId = await createSession(db, userId);

    cookies.set("session", sessionId, {
      path: "/",
      httpOnly: true,
      // Staging también se sirve por HTTPS (docs/26)
      secure: env.ENVIRONMENT === "production" || env.ENVIRONMENT === "staging",
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * 30,
    });

    // next se validó al iniciar el login y se vuelve a validar acá antes de redirigir
    return redirect(safeNext(next) ?? "/ligas");
  } catch (error) {
    locals.logger?.error("oauth_failed", { provider: params.provider, err: error });
    return redirect("/login?error=oauth_failed");
  }
});

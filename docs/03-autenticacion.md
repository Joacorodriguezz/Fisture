# Autenticación - FISTURE

## Stack de Autenticación

| Componente | Tecnología | Razón |
|------------|------------|-------|
| OAuth Library | **Arctic** | Ligera, funciona en Workers |
| Session Tokens | **Oslo** | Crypto utilities para Workers |
| Session Storage | **Cloudflare D1** (tabla `sessions`) | Revocable, atómica con el borrado de cuenta; ver `docs/21` |
| Cookies | HTTP-only, Secure | Seguridad estándar |

### ¿Por qué no NextAuth/Auth.js?

NextAuth está diseñado para Node.js y tiene dependencias que no funcionan bien en Cloudflare Workers. Arctic + Oslo son librerías específicamente diseñadas para edge runtimes.

## Providers OAuth 2.0

### 1. Google
- **Console**: https://console.cloud.google.com
- **Scopes**:
  - `openid` - Identificación
  - `email` - Email del usuario
  - `profile` - Nombre e imagen
  - `https://www.googleapis.com/auth/calendar.events` - CRUD calendario

### 2. Microsoft (Outlook)
- **Portal**: https://portal.azure.com
- **Scopes**:
  - `openid`
  - `email`
  - `profile`
  - `Calendars.ReadWrite` - CRUD calendario
  - `offline_access` - Refresh token

### 3. Apple
- **Console**: https://developer.apple.com
- **Scopes**:
  - `name`
  - `email`
- **Nota**: Apple no tiene Calendar API, se usa .ics

## Configuración de Providers (Arctic)

```typescript
// src/lib/auth/providers.ts
import { Google, MicrosoftEntraId, Apple } from "arctic"

export function createGoogleProvider(env: Env) {
  return new Google(
    env.GOOGLE_CLIENT_ID,
    env.GOOGLE_CLIENT_SECRET,
    `${env.APP_URL}/api/auth/callback/google`
  )
}

export function createMicrosoftProvider(env: Env) {
  return new MicrosoftEntraId(
    "common", // Tenant: permite cuentas personales y trabajo
    env.MICROSOFT_CLIENT_ID,
    env.MICROSOFT_CLIENT_SECRET,
    `${env.APP_URL}/api/auth/callback/microsoft`
  )
}

export function createAppleProvider(env: Env) {
  return new Apple(
    env.APPLE_CLIENT_ID,
    env.APPLE_TEAM_ID,
    env.APPLE_KEY_ID,
    env.APPLE_PRIVATE_KEY,
    `${env.APP_URL}/api/auth/callback/apple`
  )
}
```

## Flujo de Autenticación

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         FLUJO DE LOGIN                                   │
└─────────────────────────────────────────────────────────────────────────┘

Usuario click "Login con Google"
       │
       ▼
GET /api/auth/login/google
       │
       ├─► Generar state + codeVerifier (PKCE)
       ├─► Guardar el intento en una cookie firmada (HMAC, 10 min), sin KV
       └─► Redirect a Google OAuth
              │
              │  Usuario autoriza
              ▼
GET /api/auth/callback/google?code=xxx&state=xxx
       │
       ├─► Validar la cookie oauth_state_<provider> (firma, vencimiento, state y proveedor)
       ├─► Intercambiar code por tokens
       ├─► Obtener perfil de usuario
       ├─► Crear/actualizar usuario en D1
       ├─► Guardar tokens OAuth en D1 (para Calendar API)
       ├─► Crear session en D1 (guarda sha256 del token)
       └─► Set cookie + Redirect a /equipos
```

## API Endpoints de Auth

### Login Redirect

> **Estado actual:** el ejemplo de abajo es el diseño original. Hoy el estado del intento (`state`, `codeVerifier`, `provider`, `next`) no se guarda en KV sino en la cookie `oauth_state_<provider>`, firmada con HMAC-SHA256 (`src/lib/auth/oauth-state.ts`, secret `OAUTH_STATE_SECRET`). Ver `docs/20-login-sin-kv-tdd.md`.

```typescript
// src/pages/api/auth/login/[provider].ts
import type { APIRoute } from "astro"
import { generateState, generateCodeVerifier } from "arctic"
import { createGoogleProvider, createMicrosoftProvider } from "../../../lib/auth/providers"

export const GET: APIRoute = async ({ params, redirect, locals }) => {
  const { provider } = params
  const env = locals.runtime.env

  const state = generateState()
  const codeVerifier = generateCodeVerifier()

  // Guardar state y codeVerifier en KV (10 minutos TTL)
  await env.KV.put(
    `oauth:${state}`,
    JSON.stringify({ codeVerifier, provider }),
    { expirationTtl: 600 }
  )

  let authUrl: URL

  if (provider === "google") {
    const google = createGoogleProvider(env)
    authUrl = await google.createAuthorizationURL(state, codeVerifier, {
      scopes: [
        "openid",
        "email",
        "profile",
        "https://www.googleapis.com/auth/calendar.events",
      ],
    })
    // Forzar pantalla de consentimiento para obtener refresh_token
    authUrl.searchParams.set("access_type", "offline")
    authUrl.searchParams.set("prompt", "consent")
  } else if (provider === "microsoft") {
    const microsoft = createMicrosoftProvider(env)
    authUrl = await microsoft.createAuthorizationURL(state, codeVerifier, {
      scopes: [
        "openid",
        "email",
        "profile",
        "Calendars.ReadWrite",
        "offline_access",
      ],
    })
  } else if (provider === "apple") {
    const apple = createAppleProvider(env)
    authUrl = await apple.createAuthorizationURL(state, {
      scopes: ["name", "email"],
    })
  } else {
    return new Response("Provider not supported", { status: 400 })
  }

  return redirect(authUrl.toString())
}
```

### Callback Handler

```typescript
// src/pages/api/auth/callback/[provider].ts
import type { APIRoute } from "astro"
import { OAuth2Tokens } from "arctic"
import { createGoogleProvider, createMicrosoftProvider } from "../../../lib/auth/providers"
import { createSession } from "../../../lib/auth/session"
import { createDb } from "../../../lib/db"
import { users } from "../../../../drizzle/schema"
import { eq } from "drizzle-orm"

export const GET: APIRoute = async ({ params, url, redirect, cookies, locals }) => {
  const { provider } = params
  const env = locals.runtime.env

  const code = url.searchParams.get("code")
  const state = url.searchParams.get("state")

  if (!code || !state) {
    return redirect("/login?error=missing_params")
  }

  // Recuperar state de KV
  const storedData = await env.KV.get(`oauth:${state}`)
  if (!storedData) {
    return redirect("/login?error=invalid_state")
  }

  const { codeVerifier } = JSON.parse(storedData)
  await env.KV.delete(`oauth:${state}`) // Limpiar

  let tokens: OAuth2Tokens
  let userInfo: { email: string; name: string; image?: string; providerId: string }

  try {
    if (provider === "google") {
      const google = createGoogleProvider(env)
      tokens = await google.validateAuthorizationCode(code, codeVerifier)

      // Obtener info del usuario
      const response = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
        headers: { Authorization: `Bearer ${tokens.accessToken()}` },
      })
      const profile = await response.json()

      userInfo = {
        email: profile.email,
        name: profile.name,
        image: profile.picture,
        providerId: profile.id,
      }
    } else if (provider === "microsoft") {
      const microsoft = createMicrosoftProvider(env)
      tokens = await microsoft.validateAuthorizationCode(code, codeVerifier)

      const response = await fetch("https://graph.microsoft.com/v1.0/me", {
        headers: { Authorization: `Bearer ${tokens.accessToken()}` },
      })
      const profile = await response.json()

      userInfo = {
        email: profile.mail || profile.userPrincipalName,
        name: profile.displayName,
        image: undefined, // Microsoft requiere otra llamada para la foto
        providerId: profile.id,
      }
    } else {
      return redirect("/login?error=unsupported_provider")
    }

    // Crear o actualizar usuario en D1
    const db = createDb(env.DB)

    let user = await db.query.users.findFirst({
      where: eq(users.email, userInfo.email),
    })

    if (user) {
      // Actualizar tokens
      await db
        .update(users)
        .set({
          accessToken: tokens.accessToken(),
          refreshToken: tokens.refreshToken(),
          tokenExpiresAt: tokens.accessTokenExpiresAt()?.getTime(),
          name: userInfo.name,
          image: userInfo.image,
        })
        .where(eq(users.id, user.id))
    } else {
      // Crear nuevo usuario
      const [newUser] = await db
        .insert(users)
        .values({
          email: userInfo.email,
          name: userInfo.name,
          image: userInfo.image,
          provider,
          providerId: userInfo.providerId,
          accessToken: tokens.accessToken(),
          refreshToken: tokens.refreshToken(),
          tokenExpiresAt: tokens.accessTokenExpiresAt()?.getTime(),
        })
        .returning()

      user = newUser
    }

    // Crear session
    const sessionId = await createSession(env.KV, user.id)

    // Set cookie
    cookies.set("session", sessionId, {
      path: "/",
      httpOnly: true,
      secure: env.ENVIRONMENT === "production",
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * 30, // 30 días
    })

    return redirect("/equipos")
  } catch (error) {
    console.error("OAuth error:", error)
    return redirect("/login?error=oauth_failed")
  }
}
```

## Manejo de Sesión

> **Estado actual:** las sesiones viven en la tabla `sessions` de D1, no en KV (`docs/21-sesiones-en-d1-tdd.md`). La cookie `session` no cambió (mismo nombre, atributos y 30 días), pero su valor es un token de 32 bytes aleatorios (43 caracteres base64url) y la base guarda solo `sha256(token)` en hexadecimal. API en `src/lib/auth/session.ts`: `createSession(db, userId)` (devuelve el token), `getSessionUser(db, token)` (una consulta con JOIN a `users`, filtra por `expires_at`), `deleteSession`, `deleteUserSessions` (habilitada, sin UI) y `purgeExpiredSessions`. La expiración es fija a 30 días y no se renueva por request. `runSync` borra las vencidas (hasta 500 por corrida) y loguea `sessions_purged` con el conteo. El código de abajo es el diseño original con KV.

```typescript
// src/lib/auth/session.ts
import { generateRandomString } from "oslo/crypto"

export async function createSession(kv: KVNamespace, userId: string): Promise<string> {
  const sessionId = generateRandomString(32, "abcdefghijklmnopqrstuvwxyz0123456789")

  await kv.put(`session:${sessionId}`, userId, {
    expirationTtl: 60 * 60 * 24 * 30, // 30 días
  })

  return sessionId
}

export async function getSession(kv: KVNamespace, sessionId: string): Promise<string | null> {
  return kv.get(`session:${sessionId}`)
}

export async function deleteSession(kv: KVNamespace, sessionId: string): Promise<void> {
  await kv.delete(`session:${sessionId}`)
}

export async function refreshSession(kv: KVNamespace, sessionId: string): Promise<void> {
  const userId = await kv.get(`session:${sessionId}`)
  if (userId) {
    // Extender TTL
    await kv.put(`session:${sessionId}`, userId, {
      expirationTtl: 60 * 60 * 24 * 30,
    })
  }
}
```

## Middleware de Autenticación (Astro)

```typescript
// src/middleware.ts
import { defineMiddleware } from "astro:middleware"
import { getSession } from "./lib/auth/session"
import { createDb } from "./lib/db"
import { users } from "../drizzle/schema"
import { eq } from "drizzle-orm"

const PUBLIC_PATHS = ["/", "/login", "/api/auth"]

export const onRequest = defineMiddleware(async ({ locals, cookies, url, redirect }, next) => {
  const env = locals.runtime.env

  // Rutas públicas
  if (PUBLIC_PATHS.some(path => url.pathname.startsWith(path))) {
    return next()
  }

  // Verificar session
  const sessionId = cookies.get("session")?.value
  if (!sessionId) {
    return redirect("/login")
  }

  const userId = await getSession(env.KV, sessionId)
  if (!userId) {
    cookies.delete("session")
    return redirect("/login")
  }

  // Obtener usuario
  const db = createDb(env.DB)
  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
  })

  if (!user) {
    cookies.delete("session")
    return redirect("/login")
  }

  // Agregar usuario a locals para uso en páginas
  locals.user = user

  return next()
})
```

## Logout

```typescript
// src/pages/api/auth/logout.ts
import type { APIRoute } from "astro"
import { deleteSession } from "../../../lib/auth/session"

export const POST: APIRoute = async ({ cookies, redirect, locals }) => {
  const sessionId = cookies.get("session")?.value

  if (sessionId) {
    await deleteSession(locals.runtime.env.KV, sessionId)
  }

  cookies.delete("session", { path: "/" })

  return redirect("/")
}
```

## Borrado de cuenta

El usuario elimina su cuenta desde Configuración ("Zona de peligro", isla `EliminarCuenta.tsx`). Diseño completo: `docs/14-borrado-de-cuenta-tdd.md`.

`DELETE /api/cuenta` (con sesión, envuelto en `withApi`) con cuerpo `{ "confirmar": "<email>" }`:

1. Valida sesión (401), `Origin` contra `PUBLIC_APP_URL` (403, `esMismoOrigen` en `lib/auth/guards.ts`), `Content-Type: application/json` (415) y que `confirmar` coincida con el email, sin distinguir mayúsculas (400).
2. `deleteAccount` (`lib/db/account.ts`): un `DB.batch` cuenta las filas dependientes y ejecuta `DELETE FROM users`; el `ON DELETE CASCADE` se lleva `user_teams`, `user_preferences` y `calendar_syncs`. Es atómico.
3. Borra la cookie. Todas las sesiones del usuario caen por `ON DELETE CASCADE` dentro del mismo `DELETE FROM users` (ya no hay paso de KV ni `session_cleanup_failed`).
4. `revocarAcceso` (`lib/auth/revoke.ts`), best-effort y después de D1: Google revoca el grant con el refresh token (`google.revokeToken`); Microsoft no tiene endpoint público, así que el diálogo le indica revocar en `account.live.com/consent/Manage`. Un error se loguea como `account_revoke_failed` (provider y status) y no falla la request.

No se borran los eventos ya creados en el calendario del usuario. El log `account_deleted` lleva `provider` y las filas borradas por tabla, sin email ni `userId`.

## Refresh de Tokens OAuth

Los tokens de acceso expiran (~1 hora). Necesitamos refrescarlos para usar Calendar APIs.

```typescript
// src/lib/auth/tokens.ts
import { createGoogleProvider, createMicrosoftProvider } from "./providers"
import { createDb } from "../db"
import { users } from "../../../drizzle/schema"
import { eq } from "drizzle-orm"

export async function getValidAccessToken(env: Env, userId: string): Promise<string | null> {
  const db = createDb(env.DB)
  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
  })

  if (!user || !user.accessToken) return null

  // Si el token no expira pronto, usarlo
  const expiresAt = user.tokenExpiresAt || 0
  const now = Date.now()
  const fiveMinutes = 5 * 60 * 1000

  if (expiresAt > now + fiveMinutes) {
    return user.accessToken
  }

  // Necesita refresh
  if (!user.refreshToken) return null

  try {
    let newTokens

    if (user.provider === "google") {
      const google = createGoogleProvider(env)
      newTokens = await google.refreshAccessToken(user.refreshToken)
    } else if (user.provider === "microsoft") {
      const microsoft = createMicrosoftProvider(env)
      newTokens = await microsoft.refreshAccessToken(user.refreshToken)
    } else {
      return null
    }

    // Actualizar en DB
    await db
      .update(users)
      .set({
        accessToken: newTokens.accessToken(),
        refreshToken: newTokens.refreshToken() || user.refreshToken,
        tokenExpiresAt: newTokens.accessTokenExpiresAt()?.getTime(),
      })
      .where(eq(users.id, userId))

    return newTokens.accessToken()
  } catch (error) {
    console.error("Token refresh failed:", error)
    return null
  }
}
```

## Componentes de UI

### Página de Login

```astro
---
// src/pages/login.astro
import Layout from "../layouts/Layout.astro"

const error = Astro.url.searchParams.get("error")
---

<Layout title="Iniciar Sesión">
  <div class="min-h-screen flex items-center justify-center">
    <div class="max-w-md w-full space-y-8 p-8">
      <div class="text-center">
        <h1 class="text-3xl font-bold">FISTURE</h1>
        <p class="mt-2 text-gray-600">Tus partidos en tu calendario</p>
      </div>

      {error && (
        <div class="bg-red-50 text-red-600 p-4 rounded-lg">
          Error al iniciar sesión. Intenta nuevamente.
        </div>
      )}

      <div class="space-y-4">
        <a
          href="/api/auth/login/google"
          class="flex items-center justify-center gap-3 w-full py-3 px-4 border rounded-lg hover:bg-gray-50 transition"
        >
          <svg class="w-5 h-5" viewBox="0 0 24 24"><!-- Google icon --></svg>
          Continuar con Google
        </a>

        <a
          href="/api/auth/login/microsoft"
          class="flex items-center justify-center gap-3 w-full py-3 px-4 border rounded-lg hover:bg-gray-50 transition"
        >
          <svg class="w-5 h-5" viewBox="0 0 24 24"><!-- Microsoft icon --></svg>
          Continuar con Microsoft
        </a>

        <a
          href="/api/auth/login/apple"
          class="flex items-center justify-center gap-3 w-full py-3 px-4 border rounded-lg hover:bg-gray-50 transition"
        >
          <svg class="w-5 h-5" viewBox="0 0 24 24"><!-- Apple icon --></svg>
          Continuar con Apple
        </a>
      </div>

      <p class="text-center text-sm text-gray-500">
        Al continuar, aceptas nuestros términos de servicio.
      </p>
    </div>
  </div>
</Layout>
```

## Variables de Entorno

```toml
# wrangler.toml (solo para desarrollo local)
[vars]
APP_URL = "http://localhost:4321"
ENVIRONMENT = "development"

# Secrets (configurar via wrangler secret put)
# GOOGLE_CLIENT_ID
# GOOGLE_CLIENT_SECRET
# MICROSOFT_CLIENT_ID
# MICROSOFT_CLIENT_SECRET
# APPLE_CLIENT_ID
# APPLE_TEAM_ID
# APPLE_KEY_ID
# APPLE_PRIVATE_KEY
```

```bash
# Configurar secrets en producción
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET
# ... etc
```

## Dependencias

```bash
npm install arctic oslo
```

/// <reference types="astro/client" />

type D1Database = import("@cloudflare/workers-types").D1Database;
type KVNamespace = import("@cloudflare/workers-types").KVNamespace;
type R2Bucket = import("@cloudflare/workers-types").R2Bucket;

type Runtime = import("@astrojs/cloudflare").Runtime<Env>;

interface Env {
  DB: D1Database;
  KV: KVNamespace;
  R2?: R2Bucket;
  ENVIRONMENT: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  MICROSOFT_CLIENT_ID: string;
  MICROSOFT_CLIENT_SECRET: string;
  APPLE_CLIENT_ID: string;
  APPLE_TEAM_ID: string;
  APPLE_KEY_ID: string;
  APPLE_PRIVATE_KEY: string;
  API_FOOTBALL_KEY: string;
  FOOTBALL_DATA_API_KEY?: string;
  PUBLIC_APP_URL: string;
  ADMIN_SECRET?: string;
  // Firma la cookie con el estado del login OAuth (32 bytes aleatorios, secret de Pages)
  OAUTH_STATE_SECRET?: string;
}

declare namespace App {
  interface Locals extends Runtime {
    // Usuario de la sesión (lo carga el middleware si hay sesión válida)
    user?: import("../drizzle/schema").User;
    // Los pone withApi en las rutas de /api
    requestId?: string;
    logger?: import("./lib/observability/logger").Logger;
    // Si es true, withApi no agrega el userId a los logs del request (p. ej. cuenta ya borrada)
    omitirUserIdEnLog?: boolean;
  }
}

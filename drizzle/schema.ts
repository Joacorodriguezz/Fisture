import { sqliteTable, text, integer, index, uniqueIndex, primaryKey } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

// ============================================
// USUARIOS Y AUTH
// ============================================

export const users = sqliteTable(
  "users",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    // Email de contacto, normalizado (trim + minúsculas). Lo fija el alta y no lo cambia el login (docs/18 D5)
    email: text("email").notNull().unique(),
    // Algún proveedor garantizó que el email es del dueño de la cuenta (docs/18 D2)
    emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
    name: text("name"),
    image: text("image"),
    // Proveedor de calendario activo (docs/18 D4). Apunta a una fila de oauth_identities
    provider: text("provider").notNull(), // 'google' | 'microsoft' | 'apple'
    // Deprecadas desde docs/18 (D6): se mantienen por doble escritura y se eliminan en el release N+1
    providerId: text("provider_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    tokenExpiresAt: integer("token_expires_at"),
    createdAt: integer("created_at", { mode: "timestamp" }).default(
      sql`(strftime('%s', 'now'))`
    ),
    // Última vez que el sync de calendarios atendió al usuario (epoch ms; NULL = nunca). Ordena la
    // rotación: el menos atendido va primero (docs/17 D4).
    calendarReconciledAt: integer("calendar_reconciled_at"),
    // 'ok' | 'reauth_required': con 'reauth_required' el calendario perdió acceso y el sync lo salta
    // hasta que el usuario vuelva a iniciar sesión.
    calendarAuthStatus: text("calendar_auth_status").notNull().default("ok"),
  },
  (table) => ({
    calendarReconciledIdx: index("idx_users_calendar_reconciled").on(table.calendarReconciledAt),
    emailLowerIdx: uniqueIndex("users_email_lower_idx").on(sql`lower(${table.email})`),
  })
);

// Una fila por cuenta de proveedor vinculada. La identidad es (provider, provider_id), nunca el email (docs/18)
export const oauthIdentities = sqliteTable(
  "oauth_identities",
  {
    // Para la identidad principal (la que crea la migración) id = users.id
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(), // 'google' | 'microsoft'
    providerId: text("provider_id").notNull(), // Google: sub. Microsoft: oid (id de Graph)
    tenantId: text("tenant_id"), // Microsoft: tid (informativo)
    email: text("email"), // tal como lo informó el proveedor, normalizado; informativo
    emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    tokenExpiresAt: integer("token_expires_at"),
    createdAt: integer("created_at", { mode: "timestamp" }).default(sql`(strftime('%s', 'now'))`),
    lastLoginAt: integer("last_login_at", { mode: "timestamp" }).default(sql`(strftime('%s', 'now'))`),
  },
  (table) => ({
    identidadIdx: uniqueIndex("oauth_identities_provider_id_idx").on(table.provider, table.providerId),
    userProviderIdx: uniqueIndex("oauth_identities_user_provider_idx").on(table.userId, table.provider),
    userIdx: index("oauth_identities_user_id_idx").on(table.userId),
  })
);

export type OAuthIdentity = typeof oauthIdentities.$inferSelect;

// ============================================
// LIGAS Y EQUIPOS
// ============================================

export const leagues = sqliteTable("leagues", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  externalId: text("external_id").notNull().unique(),
  name: text("name").notNull(),
  country: text("country").notNull(),
  logo: text("logo"),
  season: integer("season").notNull(),
  source: text("source").notNull().default("football-data"), // 'football-data' | 'promiedos'
  isActive: integer("is_active", { mode: "boolean" }).default(true),
  // Destacada: se lista en /ligas y en la búsqueda. Las demás copas solo aparecen en el fixture de cada equipo (docs/22)
  isFeatured: integer("is_featured", { mode: "boolean" }).notNull().default(true),
});

export const teams = sqliteTable(
  "teams",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    externalId: text("external_id").notNull().unique(),
    name: text("name").notNull(),
    shortName: text("short_name"),
    logo: text("logo"),
    leagueId: text("league_id")
      .notNull()
      .references(() => leagues.id),
    country: text("country"),
    source: text("source").notNull().default("football-data"),
    updatedAt: integer("updated_at", { mode: "timestamp" }).default(
      sql`(strftime('%s', 'now'))`
    ),
  },
  (table) => ({ nameIdx: index("idx_teams_name").on(table.name) })
);

// ============================================
// PARTICIPACIÓN: qué equipos juegan cada competencia
// (un equipo juega su liga y, además, copas internacionales)
// ============================================

export const leagueTeams = sqliteTable(
  "league_teams",
  {
    leagueId: text("league_id")
      .notNull()
      .references(() => leagues.id, { onDelete: "cascade" }),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.leagueId, table.teamId] }),
    teamIdx: index("idx_league_teams_team").on(table.teamId),
  })
);

// ============================================
// RELACIÓN USUARIO - EQUIPO
// ============================================

export const userTeams = sqliteTable(
  "user_teams",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    autoSync: integer("auto_sync", { mode: "boolean" }).default(true),
    createdAt: integer("created_at", { mode: "timestamp" }).default(
      sql`(strftime('%s', 'now'))`
    ),
  },
  (table) => ({
    userIdx: index("idx_user_teams_user").on(table.userId),
    teamIdx: index("idx_user_teams_team").on(table.teamId),
  })
);

// ============================================
// PARTIDOS
// ============================================

export const matches = sqliteTable(
  "matches",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    externalId: text("external_id").notNull().unique(),
    homeTeamId: text("home_team_id")
      .notNull()
      .references(() => teams.id),
    awayTeamId: text("away_team_id")
      .notNull()
      .references(() => teams.id),
    leagueId: text("league_id")
      .notNull()
      .references(() => leagues.id),
    dateTime: integer("date_time", { mode: "timestamp" }).notNull(),
    venue: text("venue"),
    status: text("status").default("scheduled"), // scheduled, live, finished, postponed, cancelled
    homeScore: integer("home_score"),
    awayScore: integer("away_score"),
    round: text("round"),
    source: text("source").notNull().default("football-data"),
    updatedAt: integer("updated_at", { mode: "timestamp" }).default(
      sql`(strftime('%s', 'now'))`
    ),
  },
  (table) => ({
    dateIdx: index("idx_matches_date").on(table.dateTime),
    homeIdx: index("idx_matches_home_team").on(table.homeTeamId),
    awayIdx: index("idx_matches_away_team").on(table.awayTeamId),
  })
);

// ============================================
// SINCRONIZACIÓN DE CALENDARIO
// ============================================

export const calendarSyncs = sqliteTable(
  "calendar_syncs",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    matchId: text("match_id")
      .notNull()
      .references(() => matches.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(), // 'google' | 'microsoft' | 'apple'
    externalEventId: text("external_event_id"),
    status: text("status").default("pending"), // pending, synced, needs_update, failed, detached, cancelled
    lastSyncedAt: integer("last_synced_at", { mode: "timestamp" }),
    // Fecha/hora del partido con la que se creó el evento. Si cambia en
    // `matches`, el evento quedó desactualizado (status needs_update).
    syncedDateTime: integer("synced_date_time", { mode: "timestamp" }),
    // Estado relevante ('scheduled' | 'postponed' | 'cancelled') y sede con los que se creó el evento
    syncedState: text("synced_state"),
    syncedVenue: text("synced_venue"),
    errorMessage: text("error_message"),
  },
  (table) => ({
    statusIdx: index("idx_calendar_syncs_status").on(table.status),
    userMatchIdx: uniqueIndex("uq_calendar_syncs_user_match").on(table.userId, table.matchId),
  })
);

// ============================================
// PREFERENCIAS DE USUARIO
// ============================================

export const userPreferences = sqliteTable("user_preferences", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  reminder60: integer("reminder_60", { mode: "boolean" }).notNull().default(true),
  reminder15: integer("reminder_15", { mode: "boolean" }).notNull().default(true),
  theme: text("theme").notNull().default("papel"), // 'papel' | 'nocturna'
});

// ============================================
// TIPOS INFERIDOS
// ============================================

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export type League = typeof leagues.$inferSelect;
export type NewLeague = typeof leagues.$inferInsert;

export type Team = typeof teams.$inferSelect;
export type NewTeam = typeof teams.$inferInsert;

export type UserTeam = typeof userTeams.$inferSelect;
export type NewUserTeam = typeof userTeams.$inferInsert;

export type Match = typeof matches.$inferSelect;
export type NewMatch = typeof matches.$inferInsert;

export type CalendarSync = typeof calendarSyncs.$inferSelect;
export type NewCalendarSync = typeof calendarSyncs.$inferInsert;

export type UserPreferences = typeof userPreferences.$inferSelect;

// ============================================
// OBSERVABILIDAD: HISTORIAL DE SYNC
// ============================================

export const syncRuns = sqliteTable(
  "sync_runs",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    trigger: text("trigger").notNull(), // 'cron' | 'admin'
    // Qué sincronizó: 'leagues' (ESPN) o 'calendars' (reconciliación de calendarios)
    kind: text("kind").notNull().default("leagues"),
    startedAt: integer("started_at").notNull(), // epoch ms
    finishedAt: integer("finished_at"),
    status: text("status").notNull(), // running, success, partial, failed
    durationMs: integer("duration_ms"),
    results: text("results").notNull().default("[]"),
    issues: text("issues").notNull().default("[]"),
    error: text("error"),
  },
  (table) => ({
    startedIdx: index("idx_sync_runs_started").on(table.startedAt),
    kindStartedIdx: index("idx_sync_runs_kind_started").on(table.kind, table.startedAt),
  })
);

export type SyncRun = typeof syncRuns.$inferSelect;

// ============================================
// SESIONES
// ============================================

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(), // SHA-256 hex del token de la cookie (docs/21 D1)
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: integer("created_at").notNull(), // segundos Unix
    expiresAt: integer("expires_at").notNull(), // segundos Unix
  },
  (table) => ({
    userIdx: index("sessions_user_id_idx").on(table.userId),
    expiresIdx: index("sessions_expires_at_idx").on(table.expiresAt),
  })
);

export type Session = typeof sessions.$inferSelect;

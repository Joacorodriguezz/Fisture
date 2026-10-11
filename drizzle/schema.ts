import { sqliteTable, text, integer, index, primaryKey } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

// ============================================
// USUARIOS Y AUTH
// ============================================

export const users = sqliteTable("users", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  email: text("email").notNull().unique(),
  name: text("name"),
  image: text("image"),
  provider: text("provider").notNull(), // 'google' | 'microsoft' | 'apple'
  providerId: text("provider_id").notNull(),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  tokenExpiresAt: integer("token_expires_at"),
  createdAt: integer("created_at", { mode: "timestamp" }).default(
    sql`(strftime('%s', 'now'))`
  ),
});

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
  (table) => [index("idx_teams_name").on(table.name)]
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
  (table) => [
    index("idx_user_teams_user").on(table.userId),
    index("idx_user_teams_team").on(table.teamId),
  ]
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
  (table) => [
    index("idx_matches_date").on(table.dateTime),
    index("idx_matches_home_team").on(table.homeTeamId),
    index("idx_matches_away_team").on(table.awayTeamId),
  ]
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
    status: text("status").default("pending"), // pending, synced, needs_update, failed
    lastSyncedAt: integer("last_synced_at", { mode: "timestamp" }),
    // Fecha/hora del partido con la que se creó el evento. Si cambia en
    // `matches`, el evento quedó desactualizado (status needs_update).
    syncedDateTime: integer("synced_date_time", { mode: "timestamp" }),
    errorMessage: text("error_message"),
  },
  (table) => [index("idx_calendar_syncs_status").on(table.status)]
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

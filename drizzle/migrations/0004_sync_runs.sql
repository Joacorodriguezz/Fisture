-- Migration: 0004_sync_runs
-- Description: historial de ejecuciones del sync de competencias (cron o manual),
-- con resultado por competencia y hallazgos de consistencia. Alimenta /api/health.

CREATE TABLE sync_runs (
  id TEXT PRIMARY KEY,
  trigger TEXT NOT NULL,                 -- 'cron' | 'admin'
  started_at INTEGER NOT NULL,           -- epoch ms
  finished_at INTEGER,                   -- NULL mientras corre o si el Worker murió
  status TEXT NOT NULL,                  -- 'running' | 'success' | 'partial' | 'failed'
  duration_ms INTEGER,
  results TEXT NOT NULL DEFAULT '[]',    -- JSON: resultado por competencia
  issues TEXT NOT NULL DEFAULT '[]',     -- JSON: hallazgos de consistencia
  error TEXT                             -- mensaje si falló el run completo
);

CREATE INDEX idx_sync_runs_started ON sync_runs(started_at DESC);

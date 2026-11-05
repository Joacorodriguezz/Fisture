export type SyncRunStatus = "running" | "success" | "partial" | "failed";
export type SyncTrigger = "cron" | "admin";
// Qué sincronizó un run: las competencias (ESPN) o los calendarios de los usuarios
export type SyncKind = "leagues" | "calendars";

export type IssueSeverity = "warn" | "error";

export interface ConsistencyIssue {
  code: string;
  severity: IssueSeverity;
  count: number;
  // Hasta 5 IDs de ejemplo
  sample: string[];
}

// Un lote de la reconciliación de calendarios, como lo dispara POST /api/admin/sync con
// {"calendarios": true} (docs/17). El workflow encadena lotes hasta que `siguiente` es false: ese es un
// barrido. Cada lote deja un run en sync_runs con kind = calendars.
import { createDb } from "../db";
import { PRESUPUESTO_SUBREQUESTS, RESERVA_REGISTRO, Presupuesto, contarD1 } from "../calendar/presupuesto";
import { reconcileCalendarBatch } from "../calendar/reconcile";
import type { SyncDeps } from "../calendar/sync-service";
import { mensajeDeError, rootLogger, type Logger } from "./logger";
import { registrarRunCalendarios, type ResumenCalendarios } from "./sync-runs";
import type { SyncRunStatus, SyncTrigger } from "./types";

export interface CalendarBatchOptions {
  // Epoch ms del barrido en curso, devuelto por el primer lote. Sin corte este lote abre un barrido:
  // además detecta los eventos desactualizados de todos los usuarios.
  corte?: number;
  trigger?: SyncTrigger;
  logger?: Logger;
  deps?: SyncDeps;
  // Para los tests
  now?: () => number;
  presupuesto?: number;
}

export interface CalendarBatchOutcome {
  runId: string;
  status: Exclude<SyncRunStatus, "running">;
  corte: number;
  // Quedan usuarios por atender en este barrido: hay que pedir otro lote con el mismo corte
  siguiente: boolean;
  resumen: ResumenCalendarios;
  error?: string;
}

const RESUMEN_VACIO: ResumenCalendarios = {
  usuarios: 0,
  eventosOk: 0,
  eventosFallidos: 0,
  sinAcceso: 0,
  cortadoPorPresupuesto: false,
  quedan: false,
  subrequests: 0,
};

export async function runCalendarBatch(
  env: { DB: D1Database },
  options: CalendarBatchOptions = {}
): Promise<CalendarBatchOutcome> {
  const logger = (options.logger ?? rootLogger).child({ kind: "calendars" });
  const startedAt = (options.now ?? Date.now)();
  const corte = options.corte ?? startedAt;
  const trigger = options.trigger ?? "admin";

  // Todas las consultas del lote pasan por la D1 instrumentada: cuentan contra el tope de la invocación
  const presupuesto = new Presupuesto(options.presupuesto ?? PRESUPUESTO_SUBREQUESTS, RESERVA_REGISTRO);
  const db = createDb(contarD1(env.DB, presupuesto));

  let resumen = RESUMEN_VACIO;
  let status: CalendarBatchOutcome["status"] = "success";
  let error: unknown;

  try {
    resumen = await reconcileCalendarBatch(env as unknown as Env, db, options.deps, {
      now: new Date(startedAt),
      corte,
      presupuesto,
      marcarDesactualizados: options.corte === undefined,
    });
    // Sin presupuesto ni para un usuario: no avanza. Es lo único que el lote mismo considera anormal.
    if (resumen.cortadoPorPresupuesto && resumen.usuarios === 0) status = "partial";
  } catch (err) {
    error = err;
    status = "failed";
    logger.error("calendar_batch_failed", { err });
  }

  const runId = await registrarRunCalendarios(db, {
    trigger,
    startedAt,
    finishedAt: (options.now ?? Date.now)(),
    status,
    resumen: { ...resumen, subrequests: presupuesto.usado },
    error,
  });
  logger.info("calendar_batch_finished", { runId, status, ...resumen, subrequests: presupuesto.usado });

  return {
    runId,
    status,
    corte,
    siguiente: status !== "failed" && resumen.quedan,
    resumen: { ...resumen, subrequests: presupuesto.usado },
    ...(error === undefined ? {} : { error: mensajeDeError(error) }),
  };
}


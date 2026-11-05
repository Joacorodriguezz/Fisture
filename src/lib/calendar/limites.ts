// Tope de partidos por request de POST /api/calendario/sync (docs/16 §12, R2).
// Workers Free permite 50 subrequests por invocación y cuentan los fetch y cada consulta a D1 o KV (docs/17).
// Costo fijo de la request, antes de procesar el primer partido:
//   1 sesión (middleware) + 3 contadores del límite de tasa (IP, minuto, hora) + 1 lectura del interruptor
//   (KV, cacheado: peor caso) + 1 preferencias + 2 renovación del token (fetch + guardado, solo si venció).
// Costo por partido (syncMatches), peor caso:
//   1 getMatchDetail + 1 fila de calendar_syncs + 1 identidad/token + 3 llamadas al calendario cuando el
//   evento "ya no existe" (update, búsqueda por etiqueta de Microsoft y create) + 1 saveState = 7.
//   Lo habitual es 5 o 6; un partido ya al día cuesta 2.
export const SUBREQUESTS_FREE = 50;
export const COSTO_FIJO_REQUEST = 8;
export const COSTO_PARTIDO_PEOR_CASO = 7;

export const MAX_PARTIDOS_POR_REQUEST = Math.floor((SUBREQUESTS_FREE - COSTO_FIJO_REQUEST) / COSTO_PARTIDO_PEOR_CASO);

// D1 que corre `cambio` justo antes del primer batch con una sentencia cuyo SQL matchea `patron`:
// simula una escritura concurrente entre la lectura de un proceso y su batch (carreras sync/admin).
export function d1ConCambioAntesDelBatch(db: D1Database, patron: RegExp, cambio: () => Promise<unknown>): D1Database {
  // Cada sentencia envuelta recuerda su SQL y la sentencia real, que es la que recibe el batch
  const reales = new WeakMap<object, { real: D1PreparedStatement; sql: string }>();
  const envolver = (real: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const envuelta = new Proxy(real, {
      get(st, p) {
        if (p === "bind") return (...args: unknown[]) => envolver(st.bind(...args), sql);
        const v = Reflect.get(st, p);
        return typeof v === "function" ? v.bind(st) : v;
      },
    });
    reales.set(envuelta, { real, sql });
    return envuelta;
  };
  let hecho = false;
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "prepare") return (sql: string) => envolver(target.prepare(sql), sql);
      if (prop === "batch")
        return async (stmts: D1PreparedStatement[]) => {
          if (!hecho && stmts.some((s) => patron.test(reales.get(s)?.sql ?? ""))) {
            hecho = true;
            await cambio();
          }
          return target.batch(stmts.map((s) => reales.get(s)?.real ?? s));
        };
      const v = Reflect.get(target, prop);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

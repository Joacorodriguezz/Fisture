// Página pública de partido (docs/33 D2 y D3): getMatchDetail ya trae el marcador y alcanza para los textos
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { useTestDb } from "../../helpers/use-test-db";
import { seedApp } from "../../helpers/fixtures";
import { relojFijo } from "../../helpers/clock";
import { matches } from "../../../drizzle/schema";
import { getMatchDetail } from "../../../src/lib/db/queries";
import { descripcionPartido, respuestaPartido, textoResultado } from "../../../src/lib/seo-partido";

describe("página de partido", () => {
  const t = useTestDb();
  relojFijo();
  beforeEach(async () => { await seedApp(t.db); });

  it("un partido terminado con marcador en D1 da el resultado en la respuesta, la ficha y la descripción", async () => {
    await t.db.update(matches).set({ status: "finished", homeScore: 0, awayScore: 3 }).where(eq(matches.id, "superclasico"));
    const detalle = (await getMatchDetail(t.db, "superclasico"))!;
    expect(respuestaPartido(detalle)).toMatch(/^Boca Juniors le ganó 3 a 0 a River Plate el .+, por Liga de prueba, en el estadio Monumental\.$/);
    expect(textoResultado(detalle)).toBe("River Plate 0, Boca Juniors 3");
    expect(descripcionPartido(detalle)).toMatch(/^River Plate 0-3 Boca Juniors por Liga de prueba: se jugó el /);
  });

  it("con un gol nulo en D1 no hay resultado", async () => {
    await t.db.update(matches).set({ status: "finished", homeScore: 2, awayScore: null }).where(eq(matches.id, "superclasico"));
    const detalle = (await getMatchDetail(t.db, "superclasico"))!;
    expect(textoResultado(detalle)).toBeNull();
    expect(respuestaPartido(detalle)).toMatch(/El resultado todavía no está cargado\.$/);
  });
});

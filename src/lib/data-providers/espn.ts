// Cliente para la API pública de ESPN (sin API key)
// Endpoint: https://site.api.espn.com/apis/site/v2/sports/soccer/{slug}/scoreboard?dates={año}
//
// Notas de la API (verificadas contra datos reales):
// - `dates=2026` devuelve todos los partidos del año calendario (pasados y futuros).
//   Los rangos `YYYYMMDD-YYYYMMDD` responden 400, por eso se pide año por año.
// - Los IDs de equipo son los mismos en todas las competencias, así que un equipo que juega
//   la liga y una copa es una sola fila.
// - Las llaves sin definir traen equipos placeholder ("TBD Home"): se descartan.

import { LEAGUES_CONFIG } from "./types";
import type {
  DataProvider,
  FixtureOptions,
  ProviderFixture,
  ProviderLeague,
  ProviderMatch,
  ProviderTeam,
} from "./types";

const BASE_URL = "https://site.api.espn.com/apis/site/v2/sports/soccer";

// Prefijo de los IDs de este provider: evita colisiones con IDs de otras fuentes en las tablas
const PREFIJO = "espn:";

interface EspnTeam {
  id?: string;
  displayName?: string;
  shortDisplayName?: string;
  abbreviation?: string;
  logo?: string;
}

interface EspnCompetitor {
  homeAway?: "home" | "away";
  score?: string;
  team?: EspnTeam;
}

interface EspnEvent {
  id: string;
  date: string;
  season?: { year?: number; slug?: string };
  status: { type: { name: string; state: "pre" | "in" | "post" } };
  competitions: {
    venue?: { fullName?: string };
    competitors?: EspnCompetitor[];
    leg?: { value?: number };
  }[];
}

// Etapas de torneo (slug de temporada de ESPN) en español
const ETAPAS: Record<string, string> = {
  "league-phase": "Fase de liga",
  "group-stage": "Fase de grupos",
  "first-stage": "Primera fase",
  "second-stage": "Segunda fase",
  "third-stage": "Tercera fase",
  "knockout-round-playoffs": "Playoffs",
  "round-of-16": "Octavos de final",
  quarterfinals: "Cuartos de final",
  semifinals: "Semifinales",
  final: "Final",
  "torneo-apertura": "Apertura",
  "torneo-clausura": "Clausura",
};

// Etapas donde cada equipo juega varias fechas: se numera la fecha
const ETAPAS_CON_FECHAS = new Set(["league-phase", "group-stage", "torneo-apertura", "torneo-clausura"]);

// Equipos que ESPN usa mientras la llave no está definida
function esPlaceholder(team: EspnTeam | undefined): boolean {
  if (!team?.id) return true;
  const nombre = (team.displayName || "").trim();
  return !nombre || /^(tbd|tbc)\b/i.test(nombre) || /^(winner|loser|runner)s?\b/i.test(nombre);
}

function mapStatus(status: EspnEvent["status"]): ProviderMatch["status"] {
  const nombre = status.type.name.toUpperCase();
  if (nombre.includes("POSTPONED") || nombre.includes("SUSPENDED") || nombre.includes("DELAYED")) {
    return "postponed";
  }
  if (nombre.includes("CANCEL") || nombre.includes("ABANDON")) return "cancelled";
  if (status.type.state === "in") return "live";
  if (status.type.state === "post") return "finished";
  return "scheduled";
}

// Separa el prefijo de torneo argentino ("apertura---round-of-16" → Apertura + round-of-16)
function partirEtapa(slug: string): { torneo: string | null; etapa: string } {
  const m = slug.match(/^(apertura|clausura)---(.+)$/);
  if (m) return { torneo: m[1] === "apertura" ? "Apertura" : "Clausura", etapa: m[2] };
  return { torneo: null, etapa: slug };
}

// Temporadas que hay que pedir para tener la temporada en curso completa.
// Temporada europea: arranca en agosto. De enero a julio empezó el año anterior.
export function aniosATraer(ahora: Date = new Date()): number[] {
  const anio = ahora.getUTCFullYear();
  return ahora.getUTCMonth() >= 7 ? [anio, anio + 1] : [anio - 1, anio];
}

export function createEspnClient(): DataProvider {
  async function pedirTemporada(slug: string, anio: number): Promise<EspnEvent[]> {
    const url = `${BASE_URL}/${slug}/scoreboard?dates=${anio}&limit=1000`;
    let ultimoError: unknown;

    for (let intento = 0; intento < 3; intento++) {
      try {
        const res = await fetch(url, { headers: { Accept: "application/json" } });
        // ESPN responde 400 cuando no hay calendario para ese año todavía
        if (res.status === 400) return [];
        if (!res.ok) throw new Error(`ESPN ${slug} ${anio}: HTTP ${res.status}`);

        const data = (await res.json()) as { events?: EspnEvent[] };
        return data.events ?? [];
      } catch (error) {
        ultimoError = error;
        await new Promise((r) => setTimeout(r, 400 * (intento + 1)));
      }
    }
    throw ultimoError instanceof Error ? ultimoError : new Error(`ESPN ${slug} ${anio}: sin respuesta`);
  }

  async function getFixture(slug: string, options?: FixtureOptions): Promise<ProviderFixture> {
    const anios = options?.years ?? aniosATraer();
    const porId = new Map<string, EspnEvent>();

    for (const anio of anios) {
      const eventos = await pedirTemporada(slug, anio);
      for (const e of eventos) porId.set(e.id, e);
    }

    const equipos = new Map<string, ProviderTeam>();
    const eventos = [...porId.values()].sort((a, b) => a.date.localeCompare(b.date));

    // Temporada en curso: la del partido más cercano a hoy. Los equipos de temporadas
    // anteriores (descendidos, eliminados en rondas previas) no participan de esta.
    const ahora = Date.now();
    let cercano: EspnEvent | undefined;
    for (const e of eventos) {
      if (!cercano || Math.abs(Date.parse(e.date) - ahora) < Math.abs(Date.parse(cercano.date) - ahora)) cercano = e;
    }
    const temporada = cercano?.season?.year;
    const participantes = new Set<string>();

    // Cantidad de partidos por equipo dentro de cada etapa, para numerar las fechas
    const jugados = new Map<string, number>();
    const partidos: ProviderMatch[] = [];

    for (const e of eventos) {
      const comp = e.competitions?.[0];
      const competidores = comp?.competitors ?? [];
      if (competidores.length < 2) continue;

      const local = competidores.find((c) => c.homeAway === "home") ?? competidores[0];
      const visitante = competidores.find((c) => c.homeAway === "away") ?? competidores[1];
      if (esPlaceholder(local.team) || esPlaceholder(visitante.team)) continue;

      for (const c of [local, visitante]) {
        const t = c.team!;
        if (e.season?.year === temporada) participantes.add(`${PREFIJO}${t.id}`);
        equipos.set(`${PREFIJO}${t.id}`, {
          externalId: `${PREFIJO}${t.id}`,
          name: t.displayName!,
          shortName: t.abbreviation || t.shortDisplayName,
          logo: t.logo,
        });
      }

      const estado = mapStatus(e.status);
      const conMarcador = estado === "live" || estado === "finished";
      const goles = (c: EspnCompetitor) => {
        const n = Number.parseInt(c.score ?? "", 10);
        return conMarcador && Number.isFinite(n) ? n : null;
      };

      // Ronda: etapa del torneo + fecha (si la etapa tiene varias) + ida/vuelta
      const slugTemporada = e.season?.slug ?? "";
      const { torneo, etapa } = partirEtapa(slugTemporada);
      const etapaEsLiga = /^\d{4}(-\d{2})?-/.test(slugTemporada) && !ETAPAS[etapa];
      const partes: string[] = [];

      if (torneo && !ETAPAS[etapa]) partes.push(torneo);
      else if (torneo) partes.push(torneo, ETAPAS[etapa]);
      else if (ETAPAS[etapa]) partes.push(ETAPAS[etapa]);

      const numeraFecha = ETAPAS_CON_FECHAS.has(etapa) || (etapaEsLiga && esLigaLocal(slug));
      if (numeraFecha) {
        // Un partido aplazado le resta una fecha a uno de los dos equipos: vale el que más jugó
        const base = `${e.season?.year ?? ""}|${slugTemporada}|`;
        const claveLocal = base + local.team!.id;
        const claveVisitante = base + visitante.team!.id;
        const nLocal = (jugados.get(claveLocal) ?? 0) + 1;
        const nVisitante = (jugados.get(claveVisitante) ?? 0) + 1;
        jugados.set(claveLocal, nLocal);
        jugados.set(claveVisitante, nVisitante);
        partes.push(`Fecha ${Math.max(nLocal, nVisitante)}`);
      }

      const pierna = comp?.leg?.value;
      if (pierna === 1) partes.push("Ida");
      else if (pierna === 2) partes.push("Vuelta");

      // Se conserva la temporada en curso completa (resultados incluidos) y todo lo futuro;
      // las temporadas anteriores solo se pidieron para numerar las fechas
      if (e.season?.year !== temporada && Date.parse(e.date) < ahora) continue;

      partidos.push({
        externalId: `${PREFIJO}${e.id}`,
        homeTeamExternalId: `${PREFIJO}${local.team!.id}`,
        awayTeamExternalId: `${PREFIJO}${visitante.team!.id}`,
        dateTime: new Date(e.date),
        venue: comp?.venue?.fullName,
        status: estado,
        homeScore: goles(local),
        awayScore: goles(visitante),
        round: partes.length ? partes.join(" · ") : undefined,
      });
    }

    return { teams: [...equipos.values()], matches: partidos, participantIds: [...participantes] };
  }

  return {
    name: "espn",

    async getLeagues(): Promise<ProviderLeague[]> {
      return LEAGUES_CONFIG.filter((l) => l.source === "espn").map((l) => ({
        externalId: l.externalId,
        name: l.name,
        country: l.country,
        season: new Date().getUTCFullYear(),
      }));
    },

    async getTeams(slug: string): Promise<ProviderTeam[]> {
      return (await getFixture(slug)).teams;
    },

    async getMatches(slug: string, options?: { from?: Date; to?: Date }): Promise<ProviderMatch[]> {
      const { matches } = await getFixture(slug);
      return matches.filter(
        (m) => (!options?.from || m.dateTime >= options.from) && (!options?.to || m.dateTime <= options.to)
      );
    },

    getFixture,
  };
}

function esLigaLocal(slug: string): boolean {
  return LEAGUES_CONFIG.some((l) => l.externalId === slug && l.tipo === "liga");
}

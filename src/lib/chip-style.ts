// Chip de filtro (link) con el estilo del diseño Tribuna 90.
// Versión en string para atributos style de Astro; equivale a chipStyle() en islands/estilos.ts.
export function chipStyleCss(activo: boolean): string {
  return [
    "cursor:pointer",
    "border:2px solid var(--tinta)",
    "border-radius:2px",
    "padding:6px 12px",
    "font:700 13px/16px var(--font-rotulo)",
    "letter-spacing:.06em",
    "text-transform:uppercase",
    "text-decoration:none",
    `background:${activo ? "var(--barra-tinta)" : "var(--papel)"}`,
    `color:${activo ? "var(--crema-sobre-oscuro)" : "var(--tinta)"}`,
  ].join(";");
}

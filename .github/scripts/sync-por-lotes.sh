#!/usr/bin/env bash
# Dispara el sync de competencias lote por lote (docs/22 D4) contra APP_URL con ADMIN_SECRET.
# Un lote fallido no frena a los demás; al final sale con 1 si alguno falló y deja la lista en
# FALLIDOS (en $GITHUB_ENV si existe). Lo usan sync-cron.yml (producción) y staging.yml.
#
# Pausa entre lotes: Workers Free tolera ráfagas de CPU pero no muchos lotes pesados seguidos.
# Sin pausa, en staging los últimos lotes respondían 503 con "error code: 1102" (recursos
# excedidos) y pasaban sin errores al reintentarlos un minuto después (docs/26 §9).
set -uo pipefail

: "${APP_URL:?Falta APP_URL}"
: "${ADMIN_SECRET:?Falta ADMIN_SECRET}"
PAUSA="${PAUSA_ENTRE_LOTES:-20}"
PAUSA_1102="${PAUSA_TRAS_1102:-60}"

pedir() {
  curl --fail-with-body --silent --show-error \
    --max-time 120 --retry 2 --retry-delay 15 \
    -X POST "${APP_URL%/}/api/admin/sync" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $ADMIN_SECRET" \
    -d "{\"lote\": $1}"
}

lote=0
total=20 # tope hasta conocer el real (lo informa cada respuesta)
fallidos=""
while [ -n "$lote" ]; do
  respuesta="$(pedir "$lote")"
  ok=$?
  # Recursos del Worker excedidos: se espera y se reintenta el mismo lote una vez
  if [ "$ok" -ne 0 ] && echo "$respuesta" | grep -q "1102"; then
    echo "Lote $lote: recursos excedidos (1102), reintento en ${PAUSA_1102}s"
    sleep "$PAUSA_1102"
    respuesta="$(pedir "$lote")"
    ok=$?
  fi

  if [ "$ok" -ne 0 ]; then
    echo "::error::Lote $lote falló: $respuesta"
    fallidos="$fallidos $lote"
    # Un 400 es un lote fuera de rango: no hay más. Un 401 se repetiría en todos (secret mal cargado).
    if echo "$respuesta" | grep -q "lote debe ser"; then break; fi
    if echo "$respuesta" | grep -q '"Unauthorized"'; then echo "::error::ADMIN_SECRET rechazado: se corta el sync"; break; fi
    # Un 429 (rate_limited) también se repetiría en todos los lotes: se corta en vez de seguir insistiendo
    if echo "$respuesta" | grep -q "rate_limited"; then echo "::error::Límite de tasa alcanzado (rate_limited): se corta el sync"; break; fi
    lote=$((lote + 1))
    if [ "$lote" -ge "$total" ]; then lote=""; fi
  else
    total="$(echo "$respuesta" | jq -r '.totalLotes')"
    echo "Lote $lote/$((total - 1)): $(echo "$respuesta" | jq -c '{status, competencias: [.results[] | {league, partidos: (.matchesCreated + .matchesUpdated), errores: (.errors | length)}]}')"
    lote="$(echo "$respuesta" | jq -r '.siguienteLote // empty')"
  fi

  if [ -n "$lote" ]; then sleep "$PAUSA"; fi
done

if [ -n "$fallidos" ]; then
  [ -n "${GITHUB_ENV:-}" ] && echo "FALLIDOS=$fallidos" >> "$GITHUB_ENV"
  exit 1
fi

#!/usr/bin/env bash
# Abre (o comenta) un issue de incidente para que GitHub avise por email al dueño del repo.
# Uso: incidente.sh abrir  "<título>" "<detalle>"
#      incidente.sh cerrar "<título>" "<detalle>"
# Un solo issue abierto por título: las fallas repetidas se suman como comentarios.
set -euo pipefail

accion="$1"
titulo="$2"
detalle="$3"
etiqueta="incidente"

gh label create "$etiqueta" --color B60205 --description "Alerta automática de producción" 2>/dev/null || true

numero="$(gh issue list --state open --label "$etiqueta" --search "in:title \"$titulo\"" --json number,title \
  --jq ".[] | select(.title == \"$titulo\") | .number" | head -n1)"

case "$accion" in
  abrir)
    if [ -n "$numero" ]; then
      gh issue comment "$numero" --body "$detalle"
    else
      gh issue create --title "$titulo" --label "$etiqueta" --body "$detalle"
    fi
    ;;
  cerrar)
    if [ -n "$numero" ]; then
      gh issue close "$numero" --comment "$detalle"
    fi
    ;;
  *)
    echo "Acción desconocida: $accion" >&2
    exit 2
    ;;
esac

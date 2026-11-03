# Soporte y pedidos de usuarios

## Canal

- **Dónde llegan**: el email de contacto (`CONTACTO_EMAIL` en `src/lib/legal.ts`), enlazado desde el pie de
  todas las páginas, `/ayuda`, `/privacidad` y `/terminos`. Cuando exista `contacto@fisture.com` (tarjeta de email
  del dominio), cambiar solo esa constante.
- **Respuesta objetivo**: 48 h hábiles para consultas; **10 días corridos** como máximo para pedidos de datos
  personales (acceso, rectificación, supresión: Ley 25.326, art. 14 y 16).
- **Registro**: cada pedido de datos se anota en una planilla privada (fecha, tipo, cuenta, fecha de respuesta,
  qué se hizo). Sin copiar datos del usuario más allá del email. No va en este repo.

## Respuestas armadas

**"No me aparece el partido"**
> ¡Hola! Los partidos se actualizan una vez por día desde la fuente de datos. Si es una llave que todavía no
> está definida (por ejemplo, octavos con rival a confirmar), aparece cuando se conoce el cruce. ¿Me pasás el
> equipo y la competencia? Lo reviso.

Para revisar: buscar el equipo en `/equipos/buscar`, ver si la competencia está en `LEAGUES_CONFIG` (docs/09) y el
último run en `/api/admin/status`.

**"El horario está mal"**
> ¡Gracias por avisar! Tomamos el horario oficial de la fuente y lo mostramos en hora de Argentina. Si cambió
> hace poco, se corrige en la próxima actualización (una vez por día) y también en tu calendario. ¿Qué partido es?

Para revisar: comparar con ESPN; si ESPN ya lo cambió, disparar un sync (runbook §4).

**"Quiero borrar mis datos"**
> Podés hacerlo vos mismo en Configuración → Eliminar cuenta: borra tu cuenta, tus equipos y los tokens de
> calendario en el momento. Los eventos que ya están en tu calendario quedan ahí y los podés borrar a mano.
> Si preferís que lo haga yo, respondé este mail desde la dirección con la que te registraste.

Hacerlo a mano solo si el pedido llega desde el email de la cuenta. Registrar el pedido.

**"Quiero revocar el acceso a mi calendario"**
> Desde tu cuenta: Google → myaccount.google.com/permissions, o Microsoft → account.live.com/consent/Manage
> (cuentas de trabajo: myapps.microsoft.com), y quitá FISTURE. Si además querés borrar tu cuenta en FISTURE, está
> en Configuración → Eliminar cuenta.

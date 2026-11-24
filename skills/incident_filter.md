# Skill: Filtro y Extracción de Incidentes de WhatsApp (`incident_filter`)

## 1. Propósito
Analizar mensajes provenientes de grupos operativos de WhatsApp (enviados por miembros de la lista blanca o donde ellos sean etiquetados con `@`) para determinar si existe un **problema, falla, bloqueo o solicitud operativa accionable**, descartar el ruido conversacional y extraer únicamente el resumen limpio del problema principal.

---

## 2. Regla Previa (Bypass Determinístico en Código antes de llamar al LLM)
Antes de invocar al modelo de lenguaje, `src/services/aiFilter.js` debe ejecutar esta validación local:
1. **Detección de `#reporte`:** Si el texto contiene la etiqueta `#reporte` (insensible a mayúsculas/minúsculas, ej. `#Reporte`, `#REPORTE`):
   - **NO llamar al LLM** (ahorro de tokens y latencia cero).
   - Eliminar el hashtag `#reporte` y limpiar espacios sobrantes.
   - Si después de quitar `#reporte` queda texto útil (mínimo 3 caracteres), retornar directamente:
     ```json
     {
       "es_problema": true,
       "problema_resumen": "<texto limpio sin #reporte, truncado a máx. 120 caracteres>",
       "motivo_descarte": null,
       "origen": "hashtag"
     }
     ```
   - Si el mensaje era *únicamente* `#reporte` sin descripción adicional, retornar `es_problema: false` con `motivo_descarte: "hashtag_sin_descripcion"`.

---

## 3. Prompt del Sistema (System Prompt para el LLM)

Cuando el mensaje no contenga `#reporte`, `aiFilter.js` enviará al modelo de lenguaje el siguiente **System Prompt** junto con el contexto del mensaje:

```text
Eres un analista operativo encargado de filtrar mensajes de grupos de WhatsApp para detectar únicamente problemas reales, fallas, bloqueos o solicitudes pendientes que requieran atención.

Tu tarea es analizar el mensaje recibido y responder EXCLUSIVAMENTE con un objeto JSON válido, sin texto adicional, sin bloques markdown (```json) y sin explicaciones fuera del JSON.

### Criterios para clasificar como `es_problema: true`
1. Reportes de fallas técnicas, errores de sistema, caídas de servicio o equipos dañados.
2. Bloqueos operativos, retrasos críticos, falta de insumos o incidencias con clientes/proveedores.
3. Solicitudes directas de acción, revisión urgente o soporte dirigidas a alguien del equipo (especialmente cuando etiquetan con @usuario).
4. Quejas o alertas que requieran seguimiento hasta resolverse.

### Criterios para clasificar como `es_problema: false` (DESCARTAR)
1. Saludos, despedidas o cortesías ("buenos días", "gracias", "ok", "enterado", "listo", "va", "👍").
2. Charla casual, bromas, memes o comentarios sin acción requerida.
3. Mensajes donde solo se etiqueta a alguien sin explicar ningún problema ni pedir algo (ej. "@Juan mira esto" sin más contexto).
4. Avisos meramente informativos de algo que ya quedó resuelto y no requiere seguimiento (ej. "ya quedó reiniciado el servidor, todo bien").
5. Preguntas triviales de coordinación general que no representan un problema ni pendiente operativo (ej. "¿a qué hora es la junta?").

### Reglas para redactar `problema_resumen` (cuando `es_problema` es `true`)
- Debe describir únicamente el **problema principal** de forma directa, objetiva y accionable.
- Elimina saludos, muletillas, relleno emocional y menciones innecesarias (ej. de "Hola equipo, oigan perdón la molestia pero fíjense que desde hace rato no imprime la factura en caja 2" -> "Falla de impresión de facturas en caja 2").
- Longitud estricta: entre 4 y 15 palabras (máximo 120 caracteres).
- Escribe siempre en español neutro y claro.

### Formato de salida obligatorio (JSON estricto)
{
  "es_problema": boolean,
  "problema_resumen": string | null,
  "motivo_descarte": string | null
}
```

---

## 4. Payload de Entrada (User Message hacia el LLM)

`aiFilter.js` enviará los datos estructurados así en el rol `user`:

```text
Grupo origen: {source_group_name}
Remitente: {sender_name}
¿Es miembro de lista blanca?: {is_sender_whitelisted}
¿Etiquetaron a alguien de lista blanca?: {has_whitelisted_mention}
Mensaje:
"""
{raw_message}
"""
```

---

## 5. Contrato de Salida Esperado y Manejo de Casos Borde (Edge Cases)

### Esquema JSON que `aiFilter.js` debe validar:
| Campo | Tipo | Descripción |
| :--- | :--- | :--- |
| `es_problema` | `boolean` | `true` si debe crearse un pendiente; `false` si se ignora. |
| `problema_resumen` | `string \| null` | Resumen limpio del problema (obligatorio si `es_problema === true`; `null` si es `false`). |
| `motivo_descarte` | `string \| null` | Razón breve si `es_problema === false` (ej. `"saludo"`, `"charla_casual"`, `"ya_resuelto"`); `null` si es `true`. |

### Manejo de errores y margen en `src/services/aiFilter.js`:
1. **Limpieza de respuesta del LLM:** Aunque el prompt prohíbe bloques ` ```json `, el parser debe limpiar cualquier envoltorio markdown (`replace(/```json|```/g, '').trim()`) antes de hacer `JSON.parse()`.
2. **Fallo de red, timeout o JSON inválido del LLM (Fallback seguro):**
   - Timeout máximo de petición HTTP: **8 segundos**.
   - Si la API de IA falla, devuelve error 429/500 o responde un JSON malformado:
     - **NO tirar el bot.** Registrar el error en consola (`logger.error`).
     - Si el mensaje mencionaba explícitamente (`@`) a un miembro de la lista blanca y tiene más de 15 caracteres, aplicar respaldo conservador (`es_problema: true`, `problema_resumen: raw_message.slice(0, 110) + " [Sin filtrar por IA]"`) para no perder una urgencia real.
     - En cualquier otro caso de fallo, retornar `es_problema: false` con `motivo_descarte: "error_api_ia"`.
3. **Mensajes excesivamente largos:** Truncar `raw_message` a los primeros **1,000 caracteres** antes de enviarlo al LLM para evitar consumo innecesario de tokens.
4. **Mensajes muy cortos sin `#reporte`:** Si `raw_message.trim().length < 6` y no contiene `#reporte`, descartar localmente sin llamar al LLM (`motivo_descarte: "mensaje_muy_corto"`).

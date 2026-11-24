-- Supabase schema: WhatsApp pendientes dashboard (tabla `incidents` + `whitelist`)
-- Ejecutar en el Dashboard de Supabase (SQL Editor) o con psql.

-- 1) Tabla `incidents`: un registro por pendiente que se crea desde grupos monitoreados.
CREATE TABLE IF NOT EXISTS incidents (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code              text   NOT NULL UNIQUE,          -- ej. INC-1, INC-2 (desde el id serial)
  source_group_jid  text   NOT NULL,                 -- JID del grupo origen (@g.us)
  source_group_name text   NOT NULL,                 -- Nombre del grupo origen
  involved_user     text   NOT NULL,                 -- Usuario involucrado (JID o nombre)
  raw_message       text   NOT NULL,                 -- Texto original del mensaje
  problem_summary   text   NOT NULL,                 -- Resumen del problema principal
  status            text   NOT NULL DEFAULT 'ABIERTO'
                    CHECK (status IN ('ABIERTO', 'CERRADO', 'REABIERTO')),
  board_message_id  text   UNIQUE,                   -- key.id del mensaje enviado al Grupo Tablero
  updated_by        text,                            -- Quién cambió el estado
  created_at        timestamptz NOT NULL DEFAULT now(),
  closed_at         timestamptz                      -- Fecha de cierre (vacío al reabrir)
);

-- Índices útiles para el dashboard
CREATE INDEX IF NOT EXISTS incidents_status_idx ON incidents (status);
CREATE INDEX IF NOT EXISTS incidents_source_group_idx ON incidents (source_group_jid);

-- 2) Tabla `whitelist`: lista blanca dinámica, sincronizada con el Grupo Tablero.
CREATE TABLE IF NOT EXISTS whitelist (
  jid          text PRIMARY KEY,                     -- JID/número (@s.whatsapp.net o @lid)
  display_name text,
  added_at     timestamptz NOT NULL DEFAULT now()
);

-- 3) RLS: dashboard en GitHub Pages consulta solo con anon (lectura de incidents).
ALTER TABLE incidents ENABLE ROW LEVEL SECURITY;

-- PostgreSQL no soporta `CREATE POLICY IF NOT EXISTS`: se protege con un bloque DO.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'incidents' AND policyname = 'anon_select_incidents'
  ) THEN
    CREATE POLICY "anon_select_incidents" ON incidents FOR SELECT TO anon USING (true);
  END IF;
END $$;

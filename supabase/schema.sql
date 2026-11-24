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

-- 3) Tabla `monitored_groups`: grupos en los que está el bot y cuáles monitorear.
--    El dashboard (anon) puede leer la lista y marcar/desmarcar con checkbox.
CREATE TABLE IF NOT EXISTS monitored_groups (
  jid        text PRIMARY KEY,                       -- JID del grupo (@g.us)
  group_name text,                                   -- Nombre/subject del grupo
  active     boolean NOT NULL DEFAULT false,         -- ¿monitorear este grupo?
  added_at   timestamptz NOT NULL DEFAULT now()
);

-- 4) RLS: dashboard en GitHub Pages consulta solo con anon (lectura de incidents).
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

-- RLS de monitored_groups: anon puede listar y cambiar el checkbox `active`.
-- (el bot usa service_role, que necesita permisos explícitos sobre la tabla)
GRANT ALL ON monitored_groups TO service_role;
GRANT SELECT, UPDATE ON monitored_groups TO anon;
ALTER TABLE monitored_groups ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'monitored_groups' AND policyname = 'anon_select_monitored_groups'
  ) THEN
    CREATE POLICY "anon_select_monitored_groups" ON monitored_groups FOR SELECT TO anon USING (true);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'monitored_groups' AND policyname = 'anon_update_monitored_groups'
  ) THEN
    CREATE POLICY "anon_update_monitored_groups" ON monitored_groups FOR UPDATE TO anon USING (true) WITH CHECK (true);
  END IF;
END $$;

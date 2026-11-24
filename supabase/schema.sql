-- Supabase schema: WhatsApp pendientes dashboard (tablas `incidents` + `whitelist` + `monitored_groups`)
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

CREATE INDEX IF NOT EXISTS incidents_status_idx ON incidents (status);
CREATE INDEX IF NOT EXISTS incidents_source_group_idx ON incidents (source_group_jid);

-- 2) Tabla `whitelist`: lista blanca dinámica, sincronizada con el Grupo Tablero.
CREATE TABLE IF NOT EXISTS whitelist (
  jid          text PRIMARY KEY,                     -- JID/número (@s.whatsapp.net o @lid)
  display_name text,
  added_at     timestamptz NOT NULL DEFAULT now()
);

-- 3) Tabla `monitored_groups`: grupos en los que está el bot y cuáles monitorear.
CREATE TABLE IF NOT EXISTS monitored_groups (
  jid        text PRIMARY KEY,                       -- JID del grupo (@g.us)
  group_name text,                                   -- Nombre/subject del grupo
  active     boolean NOT NULL DEFAULT false,         -- ¿monitorear este grupo?
  added_at   timestamptz NOT NULL DEFAULT now()
);

-- 4) Tabla `allowed_emails`: correos con acceso al dashboard y su rol.
CREATE TABLE IF NOT EXISTS allowed_emails (
  email     text PRIMARY KEY,
  role      text NOT NULL DEFAULT 'invitado' CHECK (role IN ('admin', 'invitado')),
  added_at  timestamptz NOT NULL DEFAULT now()
);

-- Migración: agregar columna `role` si la tabla ya existía sin ella
ALTER TABLE allowed_emails ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'invitado'
  CHECK (role IN ('admin', 'invitado'));

-- Helper: ¿es el usuario actual admin? (SECURITY DEFINER evita recursión RLS)
CREATE OR REPLACE FUNCTION public.is_admin() RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM allowed_emails
    WHERE lower(email) = lower(coalesce(auth.jwt()->>'email', '')) AND role = 'admin'
  );
$$;

-- 5) Permisos: el bot usa service_role en TODAS las tablas.
GRANT ALL ON incidents, whitelist, monitored_groups, allowed_emails TO service_role;

-- Solo usuarios AUTENTICADOS pueden leer/escribir datos del dashboard.
GRANT SELECT ON incidents, whitelist, monitored_groups TO authenticated;
GRANT SELECT, UPDATE ON monitored_groups TO authenticated;

-- 6) Trigger: solo permite registro en Auth si el email está en `allowed_emails`.
CREATE OR REPLACE FUNCTION public.check_allowed_email() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM allowed_emails WHERE lower(email) = lower(NEW.email)) THEN
    RAISE EXCEPTION 'Email no autorizado para este dashboard';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_check_allowed_email ON auth.users;
CREATE TRIGGER trg_check_allowed_email
  BEFORE INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.check_allowed_email();

-- 7) Revocar cualquier grant público/anon heredado (acceso solo con login)
REVOKE ALL ON incidents, monitored_groups, whitelist, allowed_emails FROM anon;
REVOKE ALL ON incidents, monitored_groups, whitelist, allowed_emails FROM public;

-- 8) RLS
ALTER TABLE incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE monitored_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE allowed_emails ENABLE ROW LEVEL SECURITY;

-- Limpiar políticas anteriores
DROP POLICY IF EXISTS "anon_select_incidents" ON incidents;
DROP POLICY IF EXISTS "anon_select_monitored_groups" ON monitored_groups;
DROP POLICY IF EXISTS "anon_update_monitored_groups" ON monitored_groups;
DROP POLICY IF EXISTS "auth_select_incidents" ON incidents;
DROP POLICY IF EXISTS "auth_select_monitored_groups" ON monitored_groups;
DROP POLICY IF EXISTS "auth_update_monitored_groups" ON monitored_groups;
DROP POLICY IF EXISTS "auth_select_allowed_emails" ON allowed_emails;

DO $$
BEGIN
  -- incidents: lectura para cualquier usuario autenticado (admin o invitado)
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='incidents' AND policyname='auth_select_incidents') THEN
    CREATE POLICY "auth_select_incidents" ON incidents FOR SELECT TO authenticated USING (true);
  END IF;
  -- monitored_groups: SOLO admin puede listar y cambiar los checkboxes
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='monitored_groups' AND policyname='auth_select_monitored_groups') THEN
    CREATE POLICY "auth_select_monitored_groups" ON monitored_groups FOR SELECT TO authenticated USING (public.is_admin());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='monitored_groups' AND policyname='auth_update_monitored_groups') THEN
    CREATE POLICY "auth_update_monitored_groups" ON monitored_groups FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
  END IF;
  -- allowed_emails: el usuario autenticado puede leer SU PROPIA fila (para saber su rol)
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='allowed_emails' AND policyname='auth_select_allowed_emails') THEN
    CREATE POLICY "auth_select_allowed_emails" ON allowed_emails FOR SELECT TO authenticated
      USING (lower(email) = lower(coalesce(auth.jwt()->>'email', '')));
  END IF;
END $$;

GRANT SELECT ON allowed_emails TO authenticated;

-- 9) Usuario administrador inicial (editar email según tu cuenta)
INSERT INTO allowed_emails (email, role) VALUES ('adrianportillo.99@hotmail.com', 'admin')
  ON CONFLICT (email) DO UPDATE SET role = 'admin';

# DEPLOY.md — Despliegue del bot "whatsapp-pendientes-bot"

## 1. Configurar Supabase
1. Crea un proyecto nuevo en https://supabase.com (Plano Gratis).
2. Ejecuta `supabase/schema.sql` en el Dashboard (SQL Editor).
3. Rellena `docs/config.js` con `SUPABASE_URL` y `SUPABASE_ANON_KEY` del proyecto
   (el dashboard usa `anon`, política RLS de SELECT ya incluida en el schema).

## 2. VPS Ubuntu gratuito (Oracle Cloud Always Free)
1. Crea la VM y activa **2 GB de swap**.
2. Instala Node.js 20 y PM2.
3. Clona el repositorio: `git clone <url> /opt/whatsapp-pendientes-bot` (o tu ruta).
4. `npm install`.
5. Crea `.env` desde `.env.example` y completa:
   - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
   - `BOARD_GROUP_JID` (a obtener en el paso 6)
   - `AI_PROVIDER`, `AI_API_KEY`, `AI_MODEL` (Groq o Gemini)
6. Escanea el QR: `pm2 start ecosystem.config.js` (o `npm start`).
   El bot imprime el QR en la consola; vincula tu número operativo.
7. Obtén el `BOARD_GROUP_JID`: envía el texto `!id` dentro de cualquier grupo
   (desde tu número operativo); el bot responde el `remoteJid` exacto del grupo.
   Pégalo en `.env` en `BOARD_GROUP_JID` y reinicia (`pm2 restart whatsapp-pendientes-bot`).

## 3. GitHub Pages
1. Sube el repositorio a GitHub (incluye la carpeta `docs/`).
2. Activa GitHub Pages: Settings → Pages → Deploy from a branch → rama `main`
   → carpeta `/docs`.
3. Accede al dashboard en `https://<usuario>.github.io/<repo>/`.

## Notas de operación
- Arranque manual sin PM2: `npm start`.
- Logs: `pm2 logs whatsapp-pendientes-bot`.
- El bot solo filtra grupos monitoreados; la lista blanca se sincroniza con
  `BOARD_GROUP_JID` automáticamente (agregados/eliminados con `group-participants.update`).
- Avoid pulling the whole conversation: extract only text per the spec
  (`conversation`, `extendedTextMessage.text`, image/video captions).

// Configuración de PM2 (CommonJS) para usar con el pm2 global instalado.
// El ecosystem.config.js es la versión ESM documentada en la spec.
module.exports = {
  apps: [
    {
      name: 'whatsapp-pendientes-bot',
      script: 'src/index.js',
      cwd: __dirname,
      watch: false,
      max_memory_restart: '350M',
      env_file: '.env',
    },
  ],
};

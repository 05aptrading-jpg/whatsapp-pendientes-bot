// Configuración de PM2 para el VPS Ubuntu.
// max_memory_restart '350M' permite correr holgados en VPS gratuitos de 1 GB RAM.
export default {
  apps: [
    {
      name: 'whatsapp-pendientes-bot',
      script: 'src/index.js',
      interpreter: 'node',
      cwd: process.cwd(),
      watch: false,
      max_memory_restart: '350M',
      env_file: '.env',
    },
  ],
};

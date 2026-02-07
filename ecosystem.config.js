module.exports = {
  apps: [
    {
      name: 'voice-gateway',
      script: 'packages/gateway/dist/server.js',
      env: {
        PORT: 8788,
        NODE_ENV: 'production',
        LOG_LEVEL: 'info',
      },
      watch: false,
      instances: 1,
      max_memory_restart: '512M',
      error_file: './logs/gateway-error.log',
      out_file: './logs/gateway-out.log',
    },
    {
      name: 'https-proxy',
      script: 'scripts/https-proxy.mjs',
      watch: false,
      instances: 1,
      max_memory_restart: '128M',
      error_file: './logs/https-proxy-error.log',
      out_file: './logs/https-proxy-out.log',
    }
  ]
};

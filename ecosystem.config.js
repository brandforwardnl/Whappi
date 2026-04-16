module.exports = {
  apps: [{
    name: 'whatsapp-service',
    script: 'dist/index.js',
    restart_delay: 5000,
    max_restarts: 10,
    env: {
      NODE_ENV: 'production',
      PORT: 3100,
    },
  }],
};

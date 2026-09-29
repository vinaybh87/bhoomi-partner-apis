module.exports = {
  apps: [
    {
      name: 'bhoomi-partner-apis',
      cwd: '/home/ubuntu/bhoomi-partner-apis/current',
      script: 'npm',
      args: 'start',
      interpreter: 'none',
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      env: {
        NODE_ENV: 'production',
        PORT: 8011,
      },
    },
  ],
};

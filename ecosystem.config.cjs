module.exports = {
  apps: [
    {
      name: 'hhw-yy',
      script: 'src/main.ts',
      interpreter: 'node',
      interpreter_args: '--import tsx/esm',
      args: 'config.json',
      cwd: __dirname,
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 2000,
      out_file: 'logs/pm2-out.log',
      error_file: 'logs/pm2-err.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
}

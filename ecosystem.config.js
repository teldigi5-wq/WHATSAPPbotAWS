// PM2 ecosystem config — used on AWS EC2 to manage the bot process.
// Start with:  pm2 start ecosystem.config.js
// Save state:  pm2 save
// Auto-start:  pm2 startup  (then run the command it prints)

module.exports = {
  apps: [
    {
      name: 'whatsapp-bot',
      script: 'bot.js',
      instances: 1,           // WhatsApp only allows one connection per number
      autorestart: true,
      watch: false,           // Do NOT watch — file changes would restart mid-session
      max_restarts: 10,
      restart_delay: 5000,    // 5s between restarts
      max_memory_restart: '400M',

      env: {
        NODE_ENV: 'production',
        PORT: 8080,
        // DATA_PATH tells the bot where to store auth + database.
        // /data must be your mounted EBS volume (or the root EBS if no separate volume).
        DATA_PATH: '/data',
        // Your WhatsApp number in international format (no + or spaces)
        SUPER_ADMIN: '94772197530',
      },

      // PM2 log files — viewable with: pm2 logs whatsapp-bot
      out_file: '/data/logs/bot-out.log',
      error_file: '/data/logs/bot-err.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
};

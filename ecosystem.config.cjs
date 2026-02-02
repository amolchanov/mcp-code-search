module.exports = {
  apps: [{
    name: 'code-search-mcp',
    script: 'dist/index.js',
    args: '--sse',
    cwd: __dirname,
    
    // Restart settings
    autorestart: true,
    watch: false,
    max_restarts: 10,
    min_uptime: '10s',
    restart_delay: 2000,
    
    // Logging
    error_file: 'logs/error.log',
    out_file: 'logs/output.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    merge_logs: true,
    
    // Environment
    env: {
      NODE_ENV: 'production'
    },
    
    // Memory restart threshold (restart if exceeds 1GB)
    max_memory_restart: '1G',
  }]
};

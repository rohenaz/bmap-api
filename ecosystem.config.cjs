module.exports = {
  apps: [
    {
      name: 'BMAP API',
      script: 'build/index.js',
      watch: '.',
      node_args: '--openssl-legacy-provider --no-experimental-fetch',
    },
  ],

  deploy: {
    production: {
      user: 'SSH_USERNAME',
      host: 'SSH_HOSTMACHINE',
      ref: 'origin/master',
      repo: 'GIT_REPOSITORY',
      path: 'DESTINATION_PATH',
      'pre-deploy-local': '',
      'post-deploy': 'yarn && pm2 reload ecosystem.config.cjs --env production',
      'pre-setup': '',
    },
  },
}

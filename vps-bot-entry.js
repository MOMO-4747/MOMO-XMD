const { startBot } = require('./lib/bot');

startBot().catch((error) => {
  console.error('[MOMO-XMD BOT] fatal startup error:', error);
  process.exitCode = 1;
});

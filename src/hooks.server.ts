// Prevent the server from crashing on unhandled errors.
// The Anthropic SDK can leave uncaught socket errors when the API is unreachable;
// pdf-parse Worker threads can emit errors during cleanup.
process.on('unhandledRejection', (reason, promise) => {
  console.error('[server] Unhandled rejection:', (reason as Error)?.message ?? reason)
})

process.on('uncaughtException', (err, origin) => {
  console.error('[server] Uncaught exception:', err.message, '| origin:', origin)
})

process.on('exit', (code) => {
  console.error('[server] Process exiting with code:', code)
})

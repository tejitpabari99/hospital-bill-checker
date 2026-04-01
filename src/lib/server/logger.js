/**
 * Shared server-side logger for diagnostic traces.
 * Writes structured JSON lines to stderr so stdout stays available for machine-readable responses.
 */

/**
 * @typedef {Record<string, unknown>} LogDetails
 * @typedef {'info' | 'warn' | 'error'} LogLevel
 */

/**
 * @param {string} scope
 * @param {string | undefined} traceId
 */
function formatPrefix(scope, traceId) {
  return traceId ? `[${scope}:${traceId}]` : `[${scope}]`
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function safeStringify(value) {
  try {
    return JSON.stringify(value)
  } catch {
    return JSON.stringify({ message: 'Unserializable log payload' })
  }
}

/**
 * @param {LogLevel} level
 * @param {string} scope
 * @param {string | undefined} traceId
 * @param {string} stage
 * @param {LogDetails} [details]
 */
function write(level, scope, traceId, stage, details = {}) {
  const payload = {
    scope,
    traceId: traceId ?? null,
    level,
    stage,
    ts: new Date().toISOString(),
    details,
  }
  process.stderr.write(`${formatPrefix(scope, traceId)} ${safeStringify(payload)}\n`)
}

/**
 * Create a scoped logger that prefixes every message with the server area and trace id.
 *
 * @param {string} scope
 * @param {string | undefined} [traceId]
 */
export function createServerLogger(scope, traceId) {
  return {
    /**
     * @param {string} stage
     * @param {LogDetails} [details]
     */
    info(stage, details = {}) {
      write('info', scope, traceId, stage, details)
    },
    /**
     * @param {string} stage
     * @param {LogDetails} [details]
     */
    warn(stage, details = {}) {
      write('warn', scope, traceId, stage, details)
    },
    /**
     * @param {string} stage
     * @param {LogDetails} [details]
     */
    error(stage, details = {}) {
      write('error', scope, traceId, stage, details)
    },
  }
}

/**
 * Serialize an error or unknown thrown value into a stable loggable shape.
 *
 * @param {unknown} error
 */
export function serializeError(error) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    }
  }

  return {
    message: String(error),
  }
}

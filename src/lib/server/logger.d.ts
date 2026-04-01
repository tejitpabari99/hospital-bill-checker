export type LogLevel = 'info' | 'warn' | 'error'
export type LogDetails = Record<string, unknown>

export interface ServerLogger {
  info(stage: string, details?: LogDetails): void
  warn(stage: string, details?: LogDetails): void
  error(stage: string, details?: LogDetails): void
}

export function createServerLogger(scope: string, traceId?: string): ServerLogger
export function serializeError(error: unknown): { name?: string; message: string; stack?: string }

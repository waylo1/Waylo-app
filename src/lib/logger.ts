import pino from 'pino'

const isDev = process.env.NODE_ENV !== 'production'

/**
 * Logger structuré Waylo (pino).
 * - dev  : niveau DEBUG + pino-pretty (humainement lisible, coloré).
 * - prod : niveau INFO + JSON brut (compatible Loki / Datadog / CloudWatch).
 */
export const logger = pino(
  {
    level: isDev ? 'debug' : 'info',
  },
  isDev
    ? pino.transport({ target: 'pino-pretty', options: { colorize: true } })
    : undefined,
)

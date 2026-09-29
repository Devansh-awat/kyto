import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import pino, {
  transport as createTransport,
  type Logger as PinoLogger,
  type TransportTargetOptions,
} from 'pino';

export type Logger = PinoLogger;
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface CreateLoggerOptions {
  fileLogging?: boolean;
  isProduction?: boolean;
  logDirectory?: string;
  logLevel?: LogLevel;
  /** Extra fields for every line (pino's `mixin`). */
  mixin?: () => Record<string, unknown>;
  /** Sees every line that is actually emitted, in-process, before transport. */
  onLog?: (entry: {
    level: number;
    msg: string;
    obj: Record<string, unknown>;
  }) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export async function createLogger({
  fileLogging,
  isProduction = process.env.NODE_ENV === 'production',
  logDirectory = 'logs',
  logLevel = 'info',
  mixin,
  onLog,
}: CreateLoggerOptions = {}): Promise<Logger> {
  const base = {
    level: logLevel,
    timestamp: pino.stdTimeFunctions.isoTime,
    serializers: { err: pino.stdSerializers.err },
    ...(mixin ? { mixin } : {}),
    ...(onLog
      ? {
          hooks: {
            logMethod(
              this: PinoLogger,
              args: Parameters<PinoLogger['info']>,
              method: (...rest: Parameters<PinoLogger['info']>) => void,
              level: number
            ) {
              const [first, second] = args;
              try {
                onLog(
                  isRecord(first)
                    ? { level, msg: String(second ?? ''), obj: first }
                    : { level, msg: String(first ?? ''), obj: {} }
                );
              } catch {
                // A capture hook must never take logging down with it.
              }
              method.apply(this, args);
            },
          },
        }
      : {}),
  };

  if (process.env.VERCEL === '1') {
    return pino(base);
  }

  const prettyTarget: TransportTargetOptions = {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'yyyy-mm-dd HH:MM:ss.l o',
      ignore: 'pid,hostname,ctxId',
      messageFormat: '{if ctxId}[{ctxId}] {end}{msg}',
    },
  };

  const shouldFile = fileLogging ?? isProduction;

  if (!(isProduction || shouldFile)) {
    return pino(base, createTransport(prettyTarget));
  }

  if (!shouldFile) {
    return pino(base);
  }

  const targets: TransportTargetOptions[] = isProduction
    ? [{ target: 'pino/file', options: { destination: 1 }, level: logLevel }]
    : [prettyTarget];

  if (!isProduction) {
    try {
      await mkdir(logDirectory, { recursive: true });
      const runId = new Date()
        .toISOString()
        .replace('T', '_')
        .replace(/[:.]/g, '-')
        .slice(0, 19);
      targets.unshift({
        target: 'pino/file',
        options: { destination: path.join(logDirectory, `${runId}.log`) },
        level: logLevel,
      });
    } catch {
      // continue without file
    }
  }

  return pino(base, createTransport({ targets }));
}

export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export const LOG_LEVELS = Object.keys(ORDER) as LogLevel[];

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export interface LoggerOptions {
  level: LogLevel;
  /** Receives one JSON line per entry. Defaults to stdout (stderr for errors). */
  write?: (level: LogLevel, line: string) => void;
}

/** One JSON object per line, so logs can be shipped and queried without parsing free text. */
export function createLogger({ level, write = defaultWrite }: LoggerOptions): Logger {
  const emit =
    (at: LogLevel) =>
    (msg: string, fields: Record<string, unknown> = {}) => {
      if (ORDER[at] < ORDER[level]) return;
      write(at, JSON.stringify({ time: new Date().toISOString(), level: at, msg, ...fields }));
    };
  return { debug: emit("debug"), info: emit("info"), warn: emit("warn"), error: emit("error") };
}

function defaultWrite(level: LogLevel, line: string): void {
  if (level === "error") console.error(line);
  else console.log(line);
}

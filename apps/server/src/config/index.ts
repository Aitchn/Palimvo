import path from "node:path";
import { AppError } from "../errors.ts";
import { LOG_LEVELS, type LogLevel } from "../log.ts";

export interface Config {
  /** Absolute path of the data directory (database, vaults, backups). */
  dataDir: string;
  host: string;
  /** 0 picks a free port (used by tests). */
  port: number;
  /** Externally visible origin, e.g. `https://notes.example.com`. Needed for OAuth. */
  publicUrl?: string;
  trustProxy: boolean;
  /** Folder holding the built web app. Unset: look for one next to the server (see `findWebDir`). */
  webDir?: string;
  logLevel: LogLevel;
}

export type ConfigSource = "default" | "env" | "cli";

/** Where each setting came from, for the startup summary. */
export type ConfigSources = Record<keyof Config, ConfigSource>;

export interface LoadedConfig {
  config: Config;
  sources: ConfigSources;
}

interface Setting {
  key: keyof Config;
  env: string;
  flag: string;
  parse(raw: string, name: string): Config[keyof Config];
}

const SETTINGS: Setting[] = [
  { key: "dataDir", env: "PALIMVO_DATA_DIR", flag: "data-dir", parse: (v) => path.resolve(v) },
  { key: "host", env: "PALIMVO_HOST", flag: "host", parse: nonEmpty },
  { key: "port", env: "PALIMVO_PORT", flag: "port", parse: parsePort },
  { key: "publicUrl", env: "PALIMVO_PUBLIC_URL", flag: "public-url", parse: parsePublicUrl },
  { key: "webDir", env: "PALIMVO_WEB_DIR", flag: "web-dir", parse: (v) => path.resolve(v) },
  { key: "trustProxy", env: "PALIMVO_TRUST_PROXY", flag: "trust-proxy", parse: parseBool },
  { key: "logLevel", env: "PALIMVO_LOG_LEVEL", flag: "log-level", parse: parseLogLevel },
];

export const CONFIG_FLAGS = SETTINGS.map((s) => s.flag);

/** Defaults are chosen to be safe: loopback only, no proxy trust. */
export function defaultConfig(cwd: string = process.cwd()): Config {
  return {
    dataDir: path.resolve(cwd, "data"),
    host: "127.0.0.1",
    port: 3000,
    trustProxy: false,
    logLevel: "info",
  };
}

/** Precedence: CLI flags, then `PALIMVO_*` environment variables, then defaults. */
export function loadConfig(
  env: Record<string, string | undefined>,
  flags: Record<string, string | undefined> = {},
  cwd: string = process.cwd(),
): LoadedConfig {
  const config: Record<string, unknown> = { ...defaultConfig(cwd) };
  const sources = Object.fromEntries(SETTINGS.map((s) => [s.key, "default"])) as ConfigSources;
  for (const unknown of Object.keys(flags).filter((f) => !CONFIG_FLAGS.includes(f))) {
    throw new AppError("config_invalid", 400, `Unknown option --${unknown}`);
  }
  for (const s of SETTINGS) {
    const fromFlag = flags[s.flag];
    const fromEnv = env[s.env];
    const raw = fromFlag ?? fromEnv;
    if (raw === undefined || raw === "") continue;
    const name = fromFlag !== undefined ? `--${s.flag}` : s.env;
    config[s.key] = s.parse(raw, name);
    sources[s.key] = fromFlag !== undefined ? "cli" : "env";
  }
  return { config: config as unknown as Config, sources };
}

function invalid(name: string, why: string): never {
  throw new AppError("config_invalid", 400, `Invalid ${name}: ${why}`);
}

function nonEmpty(v: string, name: string): string {
  return v.trim() === "" ? invalid(name, "must not be empty") : v.trim();
}

function parsePort(v: string, name: string): number {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 65535
    ? n
    : invalid(name, `"${v}" is not a port (0-65535)`);
}

function parseBool(v: string, name: string): boolean {
  const s = v.toLowerCase();
  if (["1", "true", "yes", "on"].includes(s)) return true;
  if (["0", "false", "no", "off"].includes(s)) return false;
  return invalid(name, `"${v}" is not a boolean (true/false)`);
}

function parseLogLevel(v: string, name: string): LogLevel {
  const s = v.toLowerCase();
  return (LOG_LEVELS as string[]).includes(s)
    ? (s as LogLevel)
    : invalid(name, `"${v}" is not one of ${LOG_LEVELS.join(", ")}`);
}

function parsePublicUrl(v: string, name: string): string {
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    return invalid(name, `"${v}" is not a URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    invalid(name, "must start with http:// or https://");
  return url.origin + url.pathname.replace(/\/+$/, "");
}

/** Human-readable lines for the startup log. */
export function describeConfig({ config, sources }: LoadedConfig): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of SETTINGS) {
    const value = config[s.key];
    out[s.key] = `${value === undefined ? "(unset)" : String(value)} [${sources[s.key]}]`;
  }
  return out;
}

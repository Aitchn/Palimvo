import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { AppError as CoreError } from "@palimvo/core";
import { AppError } from "../errors.ts";

/** The generated master key lives here, next to `palimvo.db`. Back it up separately. */
export const SECRET_KEY_FILE = "secret.key";

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const VERSION = "v1";

/** Environment variable holding the master key: 32 random bytes as base64 or hex. */
export const SECRET_KEY_ENV = "PALIMVO_SECRET_KEY";

/**
 * Encrypts small secrets (API keys) with AES-256-GCM. The row id is bound in as additional
 * authenticated data, so a ciphertext copied onto another row does not decrypt.
 */
export class SecretBox {
  private constructor(
    private readonly key: Buffer,
    /** Where the key came from, for the startup log. Never the key itself. */
    readonly source: "env" | "file" | "generated",
  ) {}

  /**
   * `PALIMVO_SECRET_KEY` wins. Otherwise `<dataDir>/secret.key` is read, or created with mode
   * 0600 the first time.
   */
  static async load(dataDir: string, env: Record<string, string | undefined>): Promise<SecretBox> {
    const fromEnv = env[SECRET_KEY_ENV]?.trim();
    if (fromEnv) return new SecretBox(parseKey(fromEnv, SECRET_KEY_ENV), "env");
    const file = path.join(dataDir, SECRET_KEY_FILE);
    try {
      return new SecretBox(parseKey((await readFile(file, "utf8")).trim(), file), "file");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    const key = randomBytes(KEY_BYTES);
    await mkdir(dataDir, { recursive: true });
    try {
      // `wx`: if two servers race, only one creates the file; the other reads it.
      await writeFile(file, `${key.toString("base64")}\n`, { mode: 0o600, flag: "wx" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return SecretBox.load(dataDir, env);
      throw err;
    }
    await chmod(file, 0o600).catch(() => undefined); // not meaningful on Windows
    return new SecretBox(key, "generated");
  }

  /** For tests. */
  static fromKey(key: Buffer): SecretBox {
    if (key.length !== KEY_BYTES) throw new Error(`The key must be ${KEY_BYTES} bytes`);
    return new SecretBox(key, "env");
  }

  encrypt(plain: string, rowId: string): string {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(Buffer.from(rowId));
    const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return [VERSION, Buffer.concat([nonce, cipher.getAuthTag(), body]).toString("base64")].join(
      ":",
    );
  }

  /** Throws `secret_unreadable` when the key is not the one that encrypted the value. */
  decrypt(stored: string, rowId: string): string {
    const [version, data] = stored.split(":");
    try {
      if (version !== VERSION || !data) throw new Error("unknown format");
      const raw = Buffer.from(data, "base64");
      const decipher = createDecipheriv("aes-256-gcm", this.key, raw.subarray(0, NONCE_BYTES));
      decipher.setAAD(Buffer.from(rowId));
      decipher.setAuthTag(raw.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES));
      return Buffer.concat([
        decipher.update(raw.subarray(NONCE_BYTES + TAG_BYTES)),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      throw new CoreError("secret_unreadable");
    }
  }
}

function parseKey(text: string, where: string): Buffer {
  const candidates = [
    /^[0-9a-f]{64}$/i.test(text) ? Buffer.from(text, "hex") : undefined,
    Buffer.from(text, "base64"),
  ];
  const key = candidates.find((k) => k?.length === KEY_BYTES);
  if (!key)
    throw new AppError(
      "config_invalid",
      400,
      `${where} must be ${KEY_BYTES} random bytes as base64 or hex. Generate one with: openssl rand -base64 32`,
    );
  return key;
}

import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { AppError } from "@palimvo/core";

export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 256;

/** scrypt cost: N=2^15 (32 MiB), r=8, p=1, in line with current OWASP guidance. */
const PARAMS = { N: 1 << 15, r: 8, p: 1 } as const;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

function derive(
  password: string,
  salt: Buffer,
  length: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize("NFKC"), salt, length, options, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

/** Throws `weak_password` unless the length is acceptable. */
export function assertPasswordAllowed(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH)
    throw new AppError("weak_password", undefined, {
      min: MIN_PASSWORD_LENGTH,
      max: MAX_PASSWORD_LENGTH,
    });
}

/** `scrypt$N$r$p$salt$hash` (base64url), so the cost can be raised later without breaking old hashes. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const key = await derive(password, salt, KEY_LENGTH, {
    ...PARAMS,
    maxmem: 128 * PARAMS.N * PARAMS.r * 2,
  });
  return [
    "scrypt",
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString("base64url"),
    key.toString("base64url"),
  ].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !n || !r || !p || !salt || !hash) return false;
  const N = Number(n);
  const R = Number(r);
  const P = Number(p);
  if (!Number.isInteger(N) || !Number.isInteger(R) || !Number.isInteger(P)) return false;
  const expected = Buffer.from(hash, "base64url");
  try {
    const key = await derive(password, Buffer.from(salt, "base64url"), expected.length, {
      N,
      r: R,
      p: P,
      maxmem: 128 * N * R * 2,
    });
    return key.length === expected.length && timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

let dummy: Promise<string> | undefined;

/** Verifies against a throwaway hash so an unknown name takes as long as a wrong password. */
export async function burnPasswordCheck(password: string): Promise<void> {
  dummy ??= hashPassword("palimvo-unknown-account");
  await verifyPassword(password, await dummy);
}

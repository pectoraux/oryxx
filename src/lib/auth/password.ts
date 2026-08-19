// ORYXX — password hashing. Uses Node's built-in crypto (scrypt) so there are
// no native dependencies to compile on Vercel's serverless build.
import { randomBytes, scryptSync, timingSafeEqual } from "crypto";

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const testHash = scryptSync(password, salt, 64);
  const target = Buffer.from(hash, "hex");
  if (testHash.length !== target.length) return false;
  return timingSafeEqual(testHash, target);
}

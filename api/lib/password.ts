import bcrypt from 'bcryptjs';
import { randomBytes, createHash } from 'node:crypto';

export const hashPassword = (pwd: string) => bcrypt.hash(pwd, 10);
export const verifyPassword = (pwd: string, hash: string) => bcrypt.compare(pwd, hash);

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

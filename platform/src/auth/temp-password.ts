import crypto from 'crypto';

const BASE62_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

export function generateTempPassword(length: number = 12): string {
  const bytes = crypto.randomBytes(length);
  let password = '';

  for (let i = 0; i < length; i++) {
    password += BASE62_CHARS[bytes[i] % BASE62_CHARS.length];
  }

  return password;
}

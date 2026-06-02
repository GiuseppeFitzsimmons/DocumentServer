import argon2 from 'argon2';
export async function hashPassword(password) {
    return argon2.hash(password, {
        type: argon2.argon2id,
        memoryCost: 65536,
        timeCost: 3,
        parallelism: 1,
    });
}
export async function verifyPassword(hash, password) {
    return argon2.verify(hash, password);
}
//# sourceMappingURL=password.js.map
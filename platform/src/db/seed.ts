import { pool } from './pool.js';
import { hashPassword } from '../auth/password.js';

const DEV_USERS = [
  { email: 'dev@eurobureau.eu', password: 'password123', displayName: 'Dev User' },
  { email: 'dev2@eurobureau.eu', password: 'password123', displayName: 'Dev User Two' },
];

async function seed() {
  console.log('Seeding database...');

  for (const user of DEV_USERS) {
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [user.email]);

    if (existing.rows.length > 0) {
      console.log(`  ✓ User "${user.email}" already exists, skipping.`);
      continue;
    }

    const passwordHash = await hashPassword(user.password);
    await pool.query(
      'INSERT INTO users (email, password_hash, display_name, email_verified) VALUES ($1, $2, $3, $4)',
      [user.email, passwordHash, user.displayName, true]
    );
    console.log(`  ✓ Created user: ${user.email} / ${user.password}`);
  }

  console.log('Seed complete.');
  await pool.end();
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});

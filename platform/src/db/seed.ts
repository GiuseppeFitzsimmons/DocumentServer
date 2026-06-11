import { pool } from './pool.js';
import { hashPassword } from '../auth/password.js';

const DEV_USER = {
  email: 'dev@eurobureau.eu',
  password: 'password123',
  displayName: 'Dev User',
};

async function seed() {
  console.log('Seeding database...');

  const existing = await pool.query('SELECT id FROM users WHERE email = $1', [DEV_USER.email]);

  if (existing.rows.length > 0) {
    console.log(`  ✓ User "${DEV_USER.email}" already exists, skipping.`);
  } else {
    const passwordHash = await hashPassword(DEV_USER.password);
    await pool.query(
      'INSERT INTO users (email, password_hash, display_name, email_verified) VALUES ($1, $2, $3, $4)',
      [DEV_USER.email, passwordHash, DEV_USER.displayName, true]
    );
    console.log(`  ✓ Created user: ${DEV_USER.email} / ${DEV_USER.password}`);
  }

  console.log('Seed complete.');
  await pool.end();
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});

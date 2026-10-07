/**
 * CLI: approve a beta signup and create their account.
 *
 * Usage:
 *   npm run beta:approve -- user@example.com
 *
 * Creates a user with a temporary password, emails them the credentials, and
 * marks the signup as approved. On first login they'll be prompted to set a
 * permanent password (existing is_temp_password flow).
 */
import { pool } from '../db/pool.js';
import { hashPassword } from '../auth/password.js';
import { generateTempPassword } from '../auth/temp-password.js';
import { sendEmail } from '../email.js';

async function main() {
  const email = process.argv[2]?.trim().toLowerCase();

  if (!email || !email.includes('@')) {
    console.error('Usage: npm run beta:approve -- <email>');
    process.exit(1);
  }

  // 1. Look up the signup
  const { rows: signups } = await pool.query(
    'SELECT id, email, display_name, status FROM beta_signups WHERE email = $1',
    [email]
  );

  if (signups.length === 0) {
    console.error(`No beta signup found for "${email}".`);
    await pool.end();
    process.exit(1);
  }

  const signup = signups[0];

  if (signup.status === 'approved') {
    console.log(`Signup for "${email}" is already approved.`);
    await pool.end();
    return;
  }

  // 2. Check if user already exists
  const { rows: existing } = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
  if (existing.length > 0) {
    console.log(`User "${email}" already exists. Marking signup as approved.`);
    await pool.query(
      "UPDATE beta_signups SET status = 'approved', reviewed_at = NOW() WHERE id = $1",
      [signup.id]
    );
    await pool.end();
    return;
  }

  // 3. Create the user with a temp password
  const tempPassword = generateTempPassword();
  const passwordHash = await hashPassword(tempPassword);

  await pool.query(
    `INSERT INTO users (email, password_hash, display_name, email_verified, is_temp_password)
     VALUES ($1, $2, $3, true, true)`,
    [email, passwordHash, signup.display_name]
  );

  // 4. Mark signup as approved
  await pool.query(
    "UPDATE beta_signups SET status = 'approved', reviewed_at = NOW() WHERE id = $1",
    [signup.id]
  );

  // 5. Send welcome email
  try {
    await sendEmail({
      to: email,
      subject: 'EuroBureau — Your beta access is ready',
      text: [
        `Hi ${signup.display_name},`,
        ``,
        `Your EuroBureau beta account has been created! Here are your login details:`,
        ``,
        `  Email:    ${email}`,
        `  Password: ${tempPassword}`,
        ``,
        `Sign in at https://eurobureau.eu/login`,
        `You'll be asked to set a permanent password on your first login.`,
        ``,
        `Welcome aboard,`,
        `The EuroBureau team`,
      ].join('\n'),
      html: [
        `<p>Hi ${signup.display_name},</p>`,
        `<p>Your EuroBureau beta account has been created! Here are your login details:</p>`,
        `<p><strong>Email:</strong> ${email}<br><strong>Password:</strong> ${tempPassword}</p>`,
        `<p><a href="https://eurobureau.eu/login">Sign in here</a> — you'll be asked to set a permanent password on your first login.</p>`,
        `<p>Welcome aboard,<br>The EuroBureau team</p>`,
      ].join('\n'),
    });
    console.log(`✓ Approved "${email}" — welcome email sent (temp password: ${tempPassword})`);
  } catch (err) {
    console.error(`✓ Approved "${email}" — account created (temp password: ${tempPassword})`);
    console.error(`  ⚠ Welcome email FAILED to send:`, (err as Error).message);
    console.error(`  You may need to send the credentials manually.`);
  }

  await pool.end();
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});

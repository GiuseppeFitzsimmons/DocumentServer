#!/bin/bash
# Create a new user account via the portal container.
# Usage: ./tools/create-account.sh <email> <display_name> [environment]
#
# Creates the account with a temporary password and emails it to the user.
# The user will be forced to set a permanent password on first login.

set -euo pipefail

EMAIL="${1:-}"
DISPLAY_NAME="${2:-}"
ENV="${3:-prod}"

if [ -z "$EMAIL" ] || [ -z "$DISPLAY_NAME" ]; then
  echo "Usage: $0 <email> <display_name> [dev|prod]"
  echo ""
  echo "Examples:"
  echo "  $0 john@example.com 'John Smith'"
  echo "  $0 john@example.com 'John Smith' dev"
  exit 1
fi

# Determine which app server to connect to
if [ "$ENV" = "dev" ]; then
  APP_HOST="128.140.88.63"  # dev-app-a
  COMPOSE_FILE="docker-compose.multi.yml"
else
  APP_HOST="138.201.244.235"  # prod-app-a
  COMPOSE_FILE="docker-compose.multi.yml"
fi

echo "Creating account for: $EMAIL ($DISPLAY_NAME) on $ENV"
echo "Connecting to $APP_HOST..."

# The Node script runs inside the portal container where argon2 and email are available
NODE_SCRIPT=$(cat <<'NODESCRIPT'
const email = process.argv[2];
const displayName = process.argv[3];

(async () => {
  const { pool } = await import('./db/pool.js');
  const { hashPassword } = await import('./auth/password.js');
  const { generateTempPassword } = await import('./auth/temp-password.js');
  const { sendEmail } = await import('./email.js');

  // Check if user already exists
  const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
  if (existing.rows.length > 0) {
    console.error(`ERROR: User with email ${email} already exists`);
    process.exit(1);
  }

  // Generate temp password and hash it
  const tempPassword = generateTempPassword(14);
  const passwordHash = await hashPassword(tempPassword);

  // Insert user
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, display_name, email_verified, is_temp_password)
     VALUES ($1, $2, $3, true, true)
     RETURNING id`,
    [email, passwordHash, displayName]
  );

  const userId = rows[0].id;
  console.log(`Created user: ${userId}`);

  // Send welcome email with temp password
  try {
    await sendEmail({
      to: email,
      subject: 'Your Euro Bureau Account',
      text: [
        `Hi ${displayName},`,
        '',
        'Your Euro Bureau account has been created.',
        '',
        `Email: ${email}`,
        `Temporary Password: ${tempPassword}`,
        '',
        'Please log in and set a permanent password.',
        '',
        'https://eurobureau.eu/login',
        '',
        'Best regards,',
        'Euro Bureau',
      ].join('\n'),
      html: [
        `<p>Hi ${displayName},</p>`,
        '<p>Your Euro Bureau account has been created.</p>',
        `<p><strong>Email:</strong> ${email}<br>`,
        `<strong>Temporary Password:</strong> ${tempPassword}</p>`,
        '<p>Please log in and set a permanent password.</p>',
        '<p><a href="https://eurobureau.eu/login">Log in to Euro Bureau</a></p>',
        '<p>Best regards,<br>Euro Bureau</p>',
      ].join('\n'),
    });
    console.log(`Welcome email sent to ${email}`);
  } catch (err) {
    console.error(`WARNING: Account created but email failed: ${err.message}`);
    console.log(`Temp password (provide manually): ${tempPassword}`);
  }

  await pool.end();
  console.log('Done.');
})().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
NODESCRIPT
)

# Escape for SSH
ssh "root@${APP_HOST}" "cd /opt/euro-office/repo/deploy && docker compose -f ${COMPOSE_FILE} exec -T portal node -e '$(echo "$NODE_SCRIPT" | sed "s/'/'\\\\''/g")' -- '${EMAIL}' '${DISPLAY_NAME}'"

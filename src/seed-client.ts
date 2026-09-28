// Add/update a partner login: npx tsx src/seed-client.ts <username> <password>
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { authPool } from './db.js';

async function main() {
  const [, , username, password] = process.argv;
  if (!username || !password) {
    console.error('Usage: tsx src/seed-client.ts <username> <password>');
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(password, 12);
  await authPool.query(
    `INSERT INTO users (username, password_hash)
     VALUES ($1, $2)
     ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
    [username, passwordHash]
  );

  console.log(`User "${username}" created/updated in the apis database.`);
  await authPool.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

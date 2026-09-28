import pg from 'pg';

const { Pool } = pg;

// Separate database from bhoomi-suvidha's own — just holds partner login
// credentials (table: users).
export const authPool = new Pool({ connectionString: process.env.AUTH_DATABASE_URL });

// bhoomi-suvidha's database — read-only from here, for the /flags lookup.
export const bhoomiPool = new Pool({ connectionString: process.env.BHOOMI_DATABASE_URL });

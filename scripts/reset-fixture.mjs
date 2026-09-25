import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../apps/core/package.json', import.meta.url));
const { Pool } = require('pg');

const seedOrder = {
  id: '00000000-0000-4000-8000-000000000100',
  shipmentToken: 'seed-shipment-token',
  state: 'pre_payment',
  productSatang: 129000,
  shippingCapSatang: 4500,
  totalSatang: 133500
};

function databaseUrl() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  return process.env.DATABASE_URL;
}

export async function resetFixture(connectionString = databaseUrl()) {
  const pool = new Pool({ connectionString });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      'kplus:migrations-and-fixture-reset'
    ]);
    await client.query(
      'TRUNCATE local_provider_deliveries, domain_events, outbox_events, timers, processed_events, ledger_entries, orders, clock_state RESTART IDENTITY'
    );
    await client.query('INSERT INTO clock_state (singleton, now_at) VALUES (true, now())');
    await client.query(
      `INSERT INTO orders (id, shipment_token, state, product_satang, shipping_cap_satang, total_satang)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        seedOrder.id,
        seedOrder.shipmentToken,
        seedOrder.state,
        seedOrder.productSatang,
        seedOrder.shippingCapSatang,
        seedOrder.totalSatang
      ]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  resetFixture().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

/**
 * LOAD step of the allergen embedding backfill (any env — NO OpenAI call).
 *
 * Upserts the committed artifact (prisma/seed-data/allergen-embeddings.json) into the
 * `allergen` table, writing the pgvector `embedding` column via raw SQL. Idempotent:
 * re-running just re-upserts. This is the only step production needs — embeddings travel as data.
 *
 * Mirrors embed-icd-load.ts. Note: `prisma db seed` clears+recreates the `allergen` table
 * (seed.ts deleteMany), so if the seed is ever re-run, re-run this load afterwards to repopulate
 * the embeddings. The ON CONFLICT upsert keeps that safe and order-independent.
 *
 * Run: `npm run db:embed-allergen:load`  (needs DATABASE_URL in backend/.env)
 */
import 'dotenv/config';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { toVectorLiteral } from '../src/embeddings/embeddings.factory';

const ARTIFACT = join(__dirname, 'seed-data', 'allergen-embeddings.json');

interface AllergenEmbeddingRow {
  id: string;
  canonicalName: string;
  category: string | null;
  embedding: number[];
}

async function main(): Promise<void> {
  if (!existsSync(ARTIFACT)) {
    throw new Error(
      `Artifact not found: ${ARTIFACT}. Run \`npm run db:embed-allergen:compute\` first (dev/CI).`,
    );
  }

  const prisma = new PrismaClient();
  try {
    const rows = JSON.parse(readFileSync(ARTIFACT, 'utf8')) as AllergenEmbeddingRow[];
    console.log(`📥 loading ${rows.length} allergen embeddings into allergen...`);

    let n = 0;
    for (const r of rows) {
      // Bind the vector as a text literal and cast in SQL (`$::vector`) — that's how we write
      // the `Unsupported` pgvector column. ON CONFLICT (id) keeps the load idempotent and works
      // whether or not the seed already created the row. `id = slug(canonicalName)` is 1:1, so
      // refreshing canonical_name can't collide with the UNIQUE constraint; created_time defaults.
      const literal = toVectorLiteral(r.embedding);
      await prisma.$executeRaw`
        INSERT INTO allergen (id, canonical_name, category, embedding)
        VALUES (${r.id}, ${r.canonicalName}, ${r.category}, ${literal}::vector)
        ON CONFLICT (id) DO UPDATE
          SET canonical_name = EXCLUDED.canonical_name,
              category       = EXCLUDED.category,
              embedding      = EXCLUDED.embedding
      `;
      if (++n % 100 === 0) console.log(`  ↳ ${n}/${rows.length}`);
    }

    const [{ count }] = await prisma.$queryRaw<{ count: number }[]>`
      SELECT count(*)::int AS count FROM allergen WHERE embedding IS NOT NULL
    `;
    console.log(`✅ loaded. allergen rows with embedding: ${count}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error('❌ load failed:', e);
  process.exitCode = 1;
});

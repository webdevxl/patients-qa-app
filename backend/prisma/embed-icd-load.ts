/**
 * LOAD step of the ICD-10 embedding backfill (any env — NO OpenAI call).
 *
 * Upserts the committed artifact (prisma/seed-data/icd-embeddings.json) into the `icd_code`
 * table, writing the pgvector `embedding` column via raw SQL. Idempotent: re-running just
 * re-upserts. This is the only step production needs — embeddings travel as data.
 *
 * Run: `npm run db:embed-icd:load`  (needs DATABASE_URL in backend/.env)
 */
import 'dotenv/config';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { toVectorLiteral } from '../src/shared/embeddings/embeddings.factory';

const ARTIFACT = join(__dirname, 'seed-data', 'icd-embeddings.json');

interface IcdEmbeddingRow {
  code: string;
  description: string;
  embedding: number[];
}

async function main(): Promise<void> {
  if (!existsSync(ARTIFACT)) {
    throw new Error(
      `Artifact not found: ${ARTIFACT}. Run \`npm run db:embed-icd:compute\` first (dev/CI).`,
    );
  }

  const prisma = new PrismaClient();
  try {
    const rows = JSON.parse(readFileSync(ARTIFACT, 'utf8')) as IcdEmbeddingRow[];
    console.log(`📥 loading ${rows.length} ICD embeddings into icd_code...`);

    let n = 0;
    for (const r of rows) {
      // Bind the vector as a text literal and cast in SQL (`$::vector`) — that's how we write
      // the `Unsupported` pgvector column. ON CONFLICT keeps the load idempotent.
      const literal = toVectorLiteral(r.embedding);
      await prisma.$executeRaw`
        INSERT INTO icd_code (code, description, embedding)
        VALUES (${r.code}, ${r.description}, ${literal}::vector)
        ON CONFLICT (code) DO UPDATE
          SET description = EXCLUDED.description,
              embedding   = EXCLUDED.embedding
      `;
      if (++n % 100 === 0) console.log(`  ↳ ${n}/${rows.length}`);
    }

    const [{ count }] = await prisma.$queryRaw<{ count: number }[]>`
      SELECT count(*)::int AS count FROM icd_code WHERE embedding IS NOT NULL
    `;
    console.log(`✅ loaded. icd_code rows with embedding: ${count}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error('❌ load failed:', e);
  process.exitCode = 1;
});

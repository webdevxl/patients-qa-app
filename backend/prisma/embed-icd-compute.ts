/**
 * COMPUTE step of the ICD-10 embedding backfill (dev/CI only — calls OpenAI).
 *
 * Collects the distinct ICD-10 (code, description) pairs present in patient_condition, embeds
 * each description with `text-embedding-3-small`, and writes a committed artifact
 * (prisma/seed-data/icd-embeddings.json). Embeddings are just data: this runs ONCE; production
 * loads the artifact with `db:embed-icd:load` and never calls OpenAI.
 *
 * Incremental + cheap to re-run: existing embeddings in the artifact are reused; only new or
 * description-changed codes are re-embedded.
 *
 * Run: `npm run db:embed-icd:compute`  (needs OPENAI_API_KEY + DATABASE_URL in backend/.env)
 */
import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import {
  createEmbeddingsClient,
  EMBEDDING_MODEL,
} from '../src/shared/embeddings/embeddings.factory';

const ARTIFACT = join(__dirname, 'seed-data', 'icd-embeddings.json');
const BATCH = 256;

interface IcdEmbeddingRow {
  code: string;
  description: string;
  embedding: number[];
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    // 1. Distinct (code, description) from the data, dropping null/empty. `distinct` keeps one
    //    row per code, so the embedded vocabulary is deduped.
    const raw = await prisma.patientCondition.findMany({
      where: { icd10Code: { not: null } },
      distinct: ['icd10Code'],
      select: { icd10Code: true, icd10Description: true },
      orderBy: { icd10Code: 'asc' },
    });
    const codes = raw
      .map((r) => ({
        code: (r.icd10Code ?? '').trim(),
        description: (r.icd10Description ?? '').trim(),
      }))
      .filter((c) => c.code && c.description);

    // 2. Reuse already-embedded codes from a prior artifact (incremental; cheap re-runs).
    const existing = new Map<string, IcdEmbeddingRow>();
    if (existsSync(ARTIFACT)) {
      const prev = JSON.parse(readFileSync(ARTIFACT, 'utf8')) as IcdEmbeddingRow[];
      for (const r of prev) existing.set(r.code, r);
    }
    const todo = codes.filter(
      (c) =>
        !existing.has(c.code) || existing.get(c.code)!.description !== c.description,
    );
    console.log(
      `🧮 ${codes.length} distinct ICD codes; ${existing.size} already embedded; embedding ${todo.length} new/changed.`,
    );

    // 3. Embed the missing/changed descriptions in batches.
    const out = new Map<string, IcdEmbeddingRow>(existing);
    if (todo.length) {
      const embeddings = createEmbeddingsClient();
      for (let i = 0; i < todo.length; i += BATCH) {
        const chunk = todo.slice(i, i + BATCH);
        const vecs = await embeddings.embedDocuments(chunk.map((c) => c.description));
        chunk.forEach((c, j) =>
          out.set(c.code, { code: c.code, description: c.description, embedding: vecs[j] }),
        );
        console.log(`  ↳ embedded ${Math.min(i + BATCH, todo.length)}/${todo.length}`);
      }
    }

    // 4. Emit only codes present in the current data, sorted by code for a stable diff.
    const result = codes.map((c) => out.get(c.code)).filter(Boolean) as IcdEmbeddingRow[];
    writeFileSync(ARTIFACT, JSON.stringify(result));
    console.log(
      `✅ wrote ${result.length} embeddings (model=${EMBEDDING_MODEL}, dims=${result[0]?.embedding.length}) → ${ARTIFACT}`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error('❌ compute failed:', e);
  process.exitCode = 1;
});

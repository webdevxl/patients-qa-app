/**
 * COMPUTE step of the allergen embedding backfill (dev/CI only — calls OpenAI).
 *
 * Reads the canonical `allergen` vocabulary (built by the deterministic normalizer during
 * `prisma db seed` — see src/allergens/allergen-normalize.ts), embeds each `canonicalName`
 * with `text-embedding-3-small`, and writes a committed artifact
 * (prisma/seed-data/allergen-embeddings.json). Embeddings are just data: this runs ONCE;
 * production loads the artifact with `db:embed-allergen:load` and never calls OpenAI.
 *
 * Mirrors embed-icd-compute.ts. (ICD reads its distinct codes from patient_condition because
 * icd_code is empty until load; here the vocab already lives in `allergen` post-seed, so we
 * read it directly.) Requires the seed to have run first so the vocabulary exists.
 *
 * Incremental + cheap to re-run: existing embeddings in the artifact are reused; only new or
 * name-changed allergens are re-embedded.
 *
 * Run: `npm run db:embed-allergen:compute`  (needs OPENAI_API_KEY + DATABASE_URL in
 * the root /.env; the npm script wraps it with `node --env-file=../.env …`).
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import {
  createEmbeddingsClient,
  EMBEDDING_MODEL,
} from '../src/shared/embeddings/embeddings.factory';

const ARTIFACT = join(__dirname, 'seed-data', 'allergen-embeddings.json');
const BATCH = 256;

interface AllergenEmbeddingRow {
  id: string;
  canonicalName: string;
  category: string | null;
  embedding: number[];
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    // 1. The canonical allergen vocabulary, as seeded by the normalizer. Ordered by id for a
    //    stable artifact diff.
    const vocab = await prisma.allergen.findMany({
      select: { id: true, canonicalName: true, category: true },
      orderBy: { id: 'asc' },
    });
    const allergens = vocab
      .map((a) => ({
        id: a.id.trim(),
        canonicalName: (a.canonicalName ?? '').trim(),
        category: a.category,
      }))
      .filter((a) => a.id && a.canonicalName);

    // 2. Reuse already-embedded allergens from a prior artifact (incremental; cheap re-runs).
    const existing = new Map<string, AllergenEmbeddingRow>();
    if (existsSync(ARTIFACT)) {
      const prev = JSON.parse(readFileSync(ARTIFACT, 'utf8')) as AllergenEmbeddingRow[];
      for (const r of prev) existing.set(r.id, r);
    }
    const todo = allergens.filter(
      (a) =>
        !existing.has(a.id) || existing.get(a.id)!.canonicalName !== a.canonicalName,
    );
    console.log(
      `🧪 ${allergens.length} canonical allergens; ${existing.size} already embedded; embedding ${todo.length} new/changed.`,
    );

    // 3. Embed the missing/changed names in batches.
    const out = new Map<string, AllergenEmbeddingRow>(existing);
    if (todo.length) {
      const embeddings = createEmbeddingsClient();
      for (let i = 0; i < todo.length; i += BATCH) {
        const chunk = todo.slice(i, i + BATCH);
        const vecs = await embeddings.embedDocuments(chunk.map((a) => a.canonicalName));
        chunk.forEach((a, j) =>
          out.set(a.id, {
            id: a.id,
            canonicalName: a.canonicalName,
            category: a.category,
            embedding: vecs[j],
          }),
        );
        console.log(`  ↳ embedded ${Math.min(i + BATCH, todo.length)}/${todo.length}`);
      }
    }

    // 4. Emit only allergens present in the current vocab, sorted by id for a stable diff.
    //    Refresh category from the live vocab so reused rows don't carry a stale value.
    const result = allergens
      .map((a) => {
        const row = out.get(a.id);
        return row ? { ...row, category: a.category } : undefined;
      })
      .filter(Boolean) as AllergenEmbeddingRow[];
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

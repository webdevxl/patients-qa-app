/**
 * Deterministic allergen normalizer.
 *
 * The source `patient_allergy.allergen` column is free text: the same real-world allergen
 * shows up under many spellings — case variants (`penicillin` / `Penicillin` / `Penicillins`),
 * all-caps synonyms (`SULFA MEDICATIONS`), brand/generic pairs (`Cipro` / `ciprofloxacin`),
 * free-text noise (`PenicillinIVP CAUSES MODERATE SEVERITY WITH BLURRED VISION`), and the
 * occasional compound row (`METFORMIN, ADHESIVE TAPE`).
 *
 * `normalizeAllergen` collapses one raw string onto zero-or-more canonical allergens using a
 * small, hand-curated, auditable rule set — no embeddings, no API calls. It deliberately keeps
 * clinically distinct items apart (e.g. `Penicillin` vs `Amoxicillin`; `Sulfa Antibiotics` vs
 * `Sulfadiazine` vs `Sulfur`). Anything not covered by a rule falls through to a Title-Cased
 * version of the cleaned input, so novel allergens still get a stable canonical form.
 *
 * Used by prisma/seed.ts to build the `allergen` dictionary + `allergy_allergen` edges, and
 * reusable by a future allergen-search tool to canonicalize a user's query.
 */

export interface CanonicalAllergen {
  /** Deterministic slug, used as the Allergen primary key. */
  id: string;
  /** Display name, e.g. "Penicillin". */
  canonicalName: string;
  /** Drug | Food | Other — null when unknown (fallback uses the row's CSV category). */
  category: string | null;
  /** The source substring this canonical was derived from (kept for audit/debug). */
  rawFragment: string;
}

type Category = 'Drug' | 'Food' | 'Other';

/** A curated grouping: every alias (matched case-insensitively against the whole, cleaned
 *  fragment) collapses onto `canonicalName`. Aliases are exact-match by design — substring
 *  matching would wrongly merge e.g. `sulfadiazine` into `sulfa antibiotics`. */
interface CuratedRule {
  canonicalName: string;
  category: Category;
  aliases: string[];
}

const CURATED_RULES: CuratedRule[] = [
  // `sulfa`/`sulfas` and the spelled-out variants only. NOT `sulfadiazine` (a specific drug)
  // and NOT `sulfur` (elemental) — those stay as their own canonicals.
  {
    canonicalName: 'Sulfa Antibiotics',
    category: 'Drug',
    aliases: ['sulfa antibiotics', 'sulfa medications', 'sulfa', 'sulfas'],
  },
  // Brand `Cipro`/`CIPRO` and the generic.
  {
    canonicalName: 'Ciprofloxacin',
    category: 'Drug',
    aliases: ['cipro', 'ciprofloxacin'],
  },
  // Iodine and iodide salts grouped as the common contrast/iodine allergy.
  {
    canonicalName: 'Iodine',
    category: 'Drug',
    aliases: ['iodine', 'iodides', 'iodide'],
  },
  // Adhesive / surgical tape sensitivity.
  {
    canonicalName: 'Adhesive Tape',
    category: 'Other',
    aliases: ['tape', 'adhesive', 'adhesive tape'],
  },
];

// Flatten the curated rules into an alias -> rule lookup for O(1) exact matching.
const ALIAS_LOOKUP = new Map<string, CuratedRule>();
for (const rule of CURATED_RULES) {
  for (const alias of rule.aliases) ALIAS_LOOKUP.set(alias, rule);
}

/** A few real allergens are inherently noisy free text rather than a clean name. Matched by
 *  substring (lowercased) — only use this for tokens specific enough not to mis-hit. */
const SUBSTRING_RULES: { contains: string; canonicalName: string; category: Category }[] = [
  // Catches "Penicillin", "Penicillins", "penicillin", and the messy
  // "PenicillinIVP CAUSES MODERATE SEVERITY...". Safe: amoxicillin/augmentin lack "penicillin".
  { contains: 'penicillin', canonicalName: 'Penicillin', category: 'Drug' },
];

/** "Sulfa Antibiotics" -> "sulfa-antibiotics". Lowercase, non-alphanumeric runs -> "-", trimmed.
 *  Used as the Allergen.id so dictionary + edge inserts are idempotent without a DB round-trip. */
export function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Collapse internal whitespace and trim. Preserves the original casing. */
function clean(fragment: string): string {
  return fragment.replace(/\s+/g, ' ').trim();
}

/** Title Case fallback for fragments no rule covers, e.g. "morphine sulfate" -> "Morphine Sulfate". */
function titleCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/**
 * Normalize one raw allergen string into zero-or-more canonical allergens.
 *
 * @param raw  the source `patient_allergy.allergen` value (may be null/empty)
 * @param csvCategory  the row's `category` column, used as the fallback category for
 *                     fragments that no curated rule matches
 */
export function normalizeAllergen(
  raw: string | null | undefined,
  csvCategory?: string | null,
): CanonicalAllergen[] {
  if (raw == null) return [];
  const trimmed = clean(raw);
  if (trimmed === '') return [];

  // Split compound entries on commas only. NOT on "&" ("A&D OINTMENT", "Alka Seltzer") or
  // "-" ("Lortab 5-325mg") — those are parts of single names.
  const fragments = trimmed
    .split(',')
    .map(clean)
    .filter((f) => f !== '');

  const out: CanonicalAllergen[] = [];
  const seen = new Set<string>(); // de-dupe canonicals within a single raw string

  for (const fragment of fragments) {
    const key = fragment.toLowerCase();

    // 1. Exact curated alias.
    const aliasHit = ALIAS_LOOKUP.get(key);
    // 2. Substring rule (noisy free text).
    const substringHit = aliasHit
      ? undefined
      : SUBSTRING_RULES.find((r) => key.includes(r.contains));

    const canonicalName = aliasHit?.canonicalName ?? substringHit?.canonicalName ?? titleCase(fragment);
    const category: string | null =
      aliasHit?.category ?? substringHit?.category ?? (nullableCategory(csvCategory) ?? null);

    const id = slug(canonicalName);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, canonicalName, category, rawFragment: fragment });
  }

  return out;
}

function nullableCategory(v: string | null | undefined): string | null {
  if (v == null) return null;
  const t = v.trim();
  return t === '' ? null : t;
}

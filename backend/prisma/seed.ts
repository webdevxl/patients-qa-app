/**
 * Seeds the Patient Q&A database from the provided CSV exports.
 *
 * Run with: `npx prisma db seed` (wired via package.json -> prisma.seed).
 *
 * The CSVs have a few quirks handled defensively below:
 *   - timestamps look like "2015-12-26 16:25:00.000 -0800" (space separator,
 *     offset without a colon) which JS Date can't parse as-is
 *   - many nullable fields are empty strings rather than absent
 *   - booleans are the strings "TRUE" / "FALSE"
 *   - `legal_mailing_address` and observation `data` are JSON strings
 *
 * Seeding is idempotent: existing rows are cleared (children first) before
 * re-inserting, so the script can be run repeatedly.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'csv-parse/sync';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const DATA_DIR = join(__dirname, 'seed-data');
const BATCH_SIZE = 500;

type Row = Record<string, string>;

function readCsv(file: string): Row[] {
  const raw = readFileSync(join(DATA_DIR, file), 'utf8');
  return parse(raw, {
    columns: true,
    skip_empty_lines: true,
    relax_quotes: true,
    trim: false,
  }) as Row[];
}

// "" -> null, otherwise the trimmed-of-nothing value.
function nullify(v: string | undefined): string | null {
  if (v === undefined) return null;
  const t = v.trim();
  return t === '' ? null : v;
}

function bool(v: string | undefined): boolean | null {
  const t = nullify(v);
  if (t === null) return null;
  const u = t.trim().toUpperCase();
  if (u === 'TRUE') return true;
  if (u === 'FALSE') return false;
  return null;
}

// Date-only column, e.g. "1930-05-18".
function parseDate(v: string | undefined): Date | null {
  const t = nullify(v);
  if (t === null) return null;
  const d = new Date(`${t.trim()}T00:00:00.000Z`);
  return isNaN(d.getTime()) ? null : d;
}

// Timestamp with timezone, e.g. "2015-12-26 16:25:00.000 -0800".
function parseTs(v: string | undefined): Date | null {
  const t = nullify(v);
  if (t === null) return null;
  const s = t.trim();
  // Normalize "YYYY-MM-DD HH:mm:ss(.SSS) ±HHMM" -> ISO 8601.
  const m = s.match(
    /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s*([+-]\d{2}):?(\d{2})$/,
  );
  if (m) {
    const iso = `${m[1]}T${m[2]}${m[3]}:${m[4]}`;
    const d = new Date(iso);
    if (!isNaN(d.getTime())) return d;
  }
  const fallback = new Date(s);
  return isNaN(fallback.getTime()) ? null : fallback;
}

function json(v: string | undefined): any {
  const t = nullify(v);
  if (t === null) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

async function insertBatched<T>(
  label: string,
  rows: T[],
  insert: (chunk: T[]) => Promise<{ count: number }>,
): Promise<number> {
  let total = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const chunk = rows.slice(i, i + BATCH_SIZE);
    const res = await insert(chunk);
    total += res.count;
  }
  console.log(`  ↳ ${label}: inserted ${total}/${rows.length}`);
  return total;
}

async function main() {
  console.log('🌱 Seeding Patient Q&A database from CSVs...');

  // Clear existing data, children first (FK order). Cascade also covers this,
  // but being explicit keeps the intent obvious.
  await prisma.patientObservation.deleteMany();
  await prisma.patientMedication.deleteMany();
  await prisma.patientCondition.deleteMany();
  await prisma.patientAllergy.deleteMany();
  await prisma.patient.deleteMany();

  // ---- patient (parent) ----
  const patients = readCsv('patient.csv').map((r) => ({
    id: r.id,
    nameFirst: nullify(r.name_first),
    nameLast: nullify(r.name_last),
    dob: parseDate(r.dob),
    gender: nullify(r.gender),
    ethnicityDescription: nullify(r.ethnicity_description),
    legalMailingAddress: json(r.legal_mailing_address),
    unitDescription: nullify(r.unit_description),
    floorDescription: nullify(r.floor_description),
    roomDescription: nullify(r.room_description),
    bedDescription: nullify(r.bed_description),
    status: nullify(r.status),
    admissionTime: parseTs(r.admission_time),
    dischargeTime: parseTs(r.discharge_time),
    deathTime: parseTs(r.death_time),
    email: nullify(r.email),
    phone: nullify(r.phone),
    outpatient: bool(r.outpatient),
    revBy: nullify(r.rev_by),
    revTime: parseTs(r.rev_time),
    onLeave: bool(r.on_leave),
    group: (nullify(r.group) ?? '').trim(),
  }));
  await insertBatched('patient', patients, (c) =>
    prisma.patient.createMany({ data: c, skipDuplicates: true }),
  );

  // ---- patient_allergy ----
  const allergies = readCsv('patient_allergy.csv').map((r) => ({
    id: r.id,
    patientId: r.patient_id,
    allergen: nullify(r.allergen),
    category: nullify(r.category),
    clinicalStatus: nullify(r.clinical_status),
    createdBy: nullify(r.created_by),
    createdTime: parseTs(r.created_time),
    onsetDate: parseDate(r.onset_date),
    reactionNote: nullify(r.reaction_note),
    reactionType: nullify(r.reaction_type),
    reactionSubType: nullify(r.reaction_sub_type),
    resolvedDate: parseDate(r.resolved_date),
    revBy: nullify(r.rev_by),
    revTime: parseTs(r.rev_time),
    severity: nullify(r.severity),
    type: nullify(r.type),
  }));
  await insertBatched('patient_allergy', allergies, (c) =>
    prisma.patientAllergy.createMany({ data: c, skipDuplicates: true }),
  );

  // ---- patient_condition ----
  const conditions = readCsv('patient_condition.csv').map((r) => ({
    id: r.id,
    patientId: r.patient_id,
    clinicalStatus: nullify(r.clinical_status),
    createdBy: nullify(r.created_by),
    createdTime: parseTs(r.created_time),
    icd10Code: nullify(r.icd_10_code),
    icd10Description: nullify(r.icd_10_description),
    onsetDate: parseDate(r.onset_date),
    isPrimaryDiagnosis: bool(r.is_primary_diagnosis),
    resolvedDate: parseDate(r.resolved_date),
    revBy: nullify(r.rev_by),
    revTime: parseTs(r.rev_time),
  }));
  await insertBatched('patient_condition', conditions, (c) =>
    prisma.patientCondition.createMany({ data: c, skipDuplicates: true }),
  );

  // ---- patient_medication ----
  const medications = readCsv('patient_medication.csv').map((r) => ({
    id: r.id,
    patientId: r.patient_id,
    createdTime: parseTs(r.created_time),
    description: nullify(r.description),
    directions: nullify(r.directions),
    genericName: nullify(r.generic_name),
    narcotic: bool(r.narcotic),
    orderTime: parseTs(r.order_time),
    revTime: parseTs(r.rev_time),
    rxNormId: nullify(r.rx_norm_id),
    startTime: parseDate(r.start_time),
    status: nullify(r.status),
    strength: nullify(r.strength),
    strengthUnit: nullify(r.strength_unit),
  }));
  await insertBatched('patient_medication', medications, (c) =>
    prisma.patientMedication.createMany({ data: c, skipDuplicates: true }),
  );

  // ---- patient_observation ----
  const observations = readCsv('patient_observation.csv').map((r) => ({
    id: r.id,
    patientId: r.patient_id,
    method: nullify(r.method),
    recordedBy: nullify(r.recorded_by),
    recordedTime: parseTs(r.recorded_time),
    data: json(r.data),
  }));
  await insertBatched('patient_observation', observations, (c) =>
    prisma.patientObservation.createMany({ data: c, skipDuplicates: true }),
  );

  // ---- summary ----
  const byGroup = await prisma.patient.groupBy({
    by: ['group'],
    _count: { _all: true },
  });
  console.log('✅ Seed complete.');
  console.log(
    '   Cohorts:',
    byGroup
      .map((g) => `${g.group}=${g._count._all}`)
      .sort()
      .join(', '),
  );
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

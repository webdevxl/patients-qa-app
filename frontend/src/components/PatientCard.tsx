// Fancy patient record card rendered inside the chat window.
//
// The Q&A agent's find_patient tool is the terminal step: it returns the COMPLETE patient
// record (demographics + every condition, medication, allergy and observation) straight to
// the client. This component renders that object as an iOS-style grouped card — a tinted
// header with the patient's identity, a demographics grid, then one section per record type.
import React from 'react';
import { XStack, YStack, Text } from 'tamagui';
import { Ionicons } from '@expo/vector-icons';
import { palette, radius, cardShadow } from '../theme/palette';
import type {
  PatientDetail,
  ConditionDetail,
  MedicationDetail,
  AllergyDetail,
  ObservationDetail,
} from '../api/client';

// ───────────────────────── formatting helpers ─────────────────────────

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/**
 * ISO/date string → "Mon D, YYYY" (date portion only). We parse the leading `YYYY-MM-DD`
 * directly rather than via `new Date(...)`: `new Date('2015-10-23')` is UTC midnight, which a
 * viewer in a negative-offset timezone renders as the *previous* day. Pulling the calendar
 * parts out of the string keeps clinical dates exact and timezone-independent.
 */
function fmtDate(value: string | null): string | null {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (m) {
    const [, y, mo, d] = m;
    return `${MONTHS[Number(mo) - 1]} ${Number(d)}, ${y}`;
  }
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return value;
  return `${MONTHS[dt.getMonth()]} ${dt.getDate()}, ${dt.getFullYear()}`;
}

/** Whole years between `dob` (YYYY-MM-DD) and today — parsed by parts to avoid TZ drift. */
function age(dob: string | null): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dob ?? '');
  if (!m) return null;
  const [, y, mo, d] = m.map(Number);
  const now = new Date();
  let years = now.getFullYear() - y;
  const monthDiff = now.getMonth() + 1 - mo;
  if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < d)) years -= 1;
  return years;
}

function fullName(p: PatientDetail): string {
  const name = `${p.nameFirst ?? ''} ${p.nameLast ?? ''}`.trim();
  return name || 'Unknown patient';
}

function initials(p: PatientDetail): string {
  const a = p.nameFirst?.[0] ?? '';
  const b = p.nameLast?.[0] ?? '';
  return (a + b).toUpperCase() || '?';
}

/** Map a clinical status / severity word to a semantic color. */
function statusColor(value: string | null): string {
  const v = (value ?? '').toLowerCase();
  if (/(severe|high|critical|anaphyl)/.test(v)) return palette.red;
  if (/(moderate|medium)/.test(v)) return palette.orange;
  if (/(active|current|ongoing)/.test(v)) return palette.green;
  if (/(resolved|inactive|mild|low|completed|discontinued|stopped)/.test(v))
    return palette.secondaryLabel;
  return palette.secondaryLabel;
}

/** Render an observation's free-form JSON `data` to a readable string. */
function observationText(data: unknown): string {
  if (data == null) return '—';
  if (typeof data === 'string' || typeof data === 'number') return String(data);
  if (typeof data === 'object') {
    const o = data as Record<string, unknown>;
    const type = o.type ?? o.name;
    const unit = o.unit ?? o.units ?? '';
    const suffix = unit ? ` ${String(unit)}` : '';
    // Blood pressure carries systolic/diastolic instead of a single value.
    if (o.systolicValue != null || o.diastolicValue != null) {
      const sys = o.systolicValue ?? '?';
      const dia = o.diastolicValue ?? '?';
      return `${type ? `${String(type)}: ` : ''}${String(sys)}/${String(dia)}${suffix}`;
    }
    const value = o.value ?? o.result ?? o.measurement;
    if (type != null && value != null) {
      return `${String(type)}: ${String(value)}${suffix}`;
    }
    try {
      return JSON.stringify(data);
    } catch {
      return String(data);
    }
  }
  return String(data);
}

// ───────────────────────── building blocks ─────────────────────────

/** A small colored pill (severity, status, narcotic, primary…). */
function Tag({ label, color }: { label: string; color: string }) {
  return (
    <XStack
      paddingHorizontal={7}
      paddingVertical={2}
      borderRadius={radius.chip}
      backgroundColor={`${color}1A`}
    >
      <Text fontSize={11} fontWeight="600" color={color} letterSpacing={-0.1}>
        {label}
      </Text>
    </XStack>
  );
}

/** One label/value pair in the demographics grid. Hidden when value is empty. */
function Field({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <YStack width="50%" paddingVertical={4} paddingRight={8}>
      <Text fontSize={11} color={palette.tertiaryLabel} letterSpacing={0.2}>
        {label.toUpperCase()}
      </Text>
      <Text fontSize={14} color={palette.label} letterSpacing={-0.1}>
        {value}
      </Text>
    </YStack>
  );
}

/** Section header: icon + title + count badge. */
function SectionHeader({
  icon,
  title,
  count,
  accent,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  count: number;
  accent: string;
}) {
  return (
    <XStack alignItems="center" gap={7} marginBottom={8}>
      <Ionicons name={icon} size={15} color={accent} />
      <Text fontSize={13} fontWeight="700" color={palette.label} letterSpacing={-0.1}>
        {title}
      </Text>
      <XStack
        minWidth={20}
        paddingHorizontal={6}
        paddingVertical={1}
        borderRadius={radius.chip}
        backgroundColor={palette.tertiarySystemFill}
        alignItems="center"
        justifyContent="center"
      >
        <Text fontSize={11} fontWeight="700" color={palette.secondaryLabel}>
          {count}
        </Text>
      </XStack>
    </XStack>
  );
}

/** A single record row inside a section. */
function Row({
  title,
  subtitle,
  meta,
  tags,
}: {
  title: string;
  subtitle?: string | null;
  meta?: string | null;
  tags?: { label: string; color: string }[];
}) {
  return (
    <YStack
      paddingVertical={8}
      paddingHorizontal={10}
      borderRadius={12}
      backgroundColor={palette.systemGroupedBackground}
      gap={3}
    >
      <XStack alignItems="center" justifyContent="space-between" gap={8}>
        <Text fontSize={14} fontWeight="600" color={palette.label} flex={1} letterSpacing={-0.1}>
          {title}
        </Text>
        {tags?.length ? (
          <XStack gap={4} flexWrap="wrap" justifyContent="flex-end">
            {tags.map((t) => (
              <Tag key={t.label} label={t.label} color={t.color} />
            ))}
          </XStack>
        ) : null}
      </XStack>
      {subtitle ? (
        <Text fontSize={13} color={palette.secondaryLabel} letterSpacing={-0.1}>
          {subtitle}
        </Text>
      ) : null}
      {meta ? (
        <Text fontSize={12} color={palette.tertiaryLabel}>
          {meta}
        </Text>
      ) : null}
    </YStack>
  );
}

/** A titled section wrapper that shows an empty hint when there are no items. */
function Section({
  icon,
  title,
  count,
  accent,
  emptyHint,
  children,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  count: number;
  accent: string;
  emptyHint: string;
  children: React.ReactNode;
}) {
  return (
    <YStack>
      <SectionHeader icon={icon} title={title} count={count} accent={accent} />
      {count === 0 ? (
        <Text fontSize={13} color={palette.tertiaryLabel} paddingLeft={2}>
          {emptyHint}
        </Text>
      ) : (
        <YStack gap={6}>{children}</YStack>
      )}
    </YStack>
  );
}

// ───────────────────────── record → row mappers ─────────────────────────

function conditionRow(c: ConditionDetail, i: number) {
  const tags: { label: string; color: string }[] = [];
  if (c.isPrimaryDiagnosis) tags.push({ label: 'Primary', color: palette.blue });
  if (c.clinicalStatus)
    tags.push({ label: c.clinicalStatus, color: statusColor(c.clinicalStatus) });
  const onset = fmtDate(c.onsetDate);
  const resolved = fmtDate(c.resolvedDate);
  const meta = [
    c.icd10Code ? `ICD-10 ${c.icd10Code}` : null,
    onset ? `Onset ${onset}` : null,
    resolved ? `Resolved ${resolved}` : null,
  ]
    .filter(Boolean)
    .join('  ·  ');
  return (
    <Row
      key={`cond-${i}`}
      title={c.icd10Description ?? c.icd10Code ?? 'Condition'}
      meta={meta || null}
      tags={tags}
    />
  );
}

function medicationRow(m: MedicationDetail, i: number) {
  const tags: { label: string; color: string }[] = [];
  if (m.narcotic) tags.push({ label: 'Narcotic', color: palette.red });
  if (m.status) tags.push({ label: m.status, color: statusColor(m.status) });
  const strength = [m.strength, m.strengthUnit].filter(Boolean).join(' ');
  const title = [m.description ?? m.genericName ?? 'Medication', strength]
    .filter(Boolean)
    .join(' · ');
  const started = fmtDate(m.startTime);
  const meta = [
    m.genericName && m.description ? `Generic: ${m.genericName}` : null,
    started ? `Started ${started}` : null,
    m.rxNormId ? `RxNorm ${m.rxNormId}` : null,
  ]
    .filter(Boolean)
    .join('  ·  ');
  return (
    <Row
      key={`med-${i}`}
      title={title}
      subtitle={m.directions ?? null}
      meta={meta || null}
      tags={tags}
    />
  );
}

function allergyRow(a: AllergyDetail, i: number) {
  const tags: { label: string; color: string }[] = [];
  if (a.severity) tags.push({ label: a.severity, color: statusColor(a.severity) });
  if (a.clinicalStatus)
    tags.push({ label: a.clinicalStatus, color: statusColor(a.clinicalStatus) });
  const reaction = [a.reactionType, a.reactionSubType].filter(Boolean).join(' — ');
  const subtitle = [a.category, reaction].filter(Boolean).join(' · ');
  const onset = fmtDate(a.onsetDate);
  const meta = [a.reactionNote, onset ? `Onset ${onset}` : null]
    .filter(Boolean)
    .join('  ·  ');
  return (
    <Row
      key={`alg-${i}`}
      title={a.allergen ?? 'Allergen'}
      subtitle={subtitle || null}
      meta={meta || null}
      tags={tags}
    />
  );
}

function observationRow(o: ObservationDetail, i: number) {
  const when = fmtDate(o.recordedTime);
  const meta = [o.method, when, o.recordedBy ? `by ${o.recordedBy}` : null]
    .filter(Boolean)
    .join('  ·  ');
  return (
    <Row key={`obs-${i}`} title={observationText(o.data)} meta={meta || null} />
  );
}

// ───────────────────────── the card ─────────────────────────

export function PatientCard({
  patient,
  accent,
}: {
  patient: PatientDetail;
  accent: string;
}) {
  const yrs = age(patient.dob);
  const subline = [
    patient.gender,
    yrs != null ? `${yrs} yrs` : null,
    patient.status,
  ]
    .filter(Boolean)
    .join('  ·  ');

  const location = [
    patient.unitDescription,
    patient.floorDescription ? `Floor ${patient.floorDescription}` : null,
    patient.roomDescription ? `Room ${patient.roomDescription}` : null,
    patient.bedDescription ? `Bed ${patient.bedDescription}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <YStack
      marginHorizontal={16}
      marginTop={10}
      backgroundColor={palette.surface}
      borderRadius={radius.card}
      borderWidth={1}
      borderColor={palette.hairline}
      overflow="hidden"
      style={cardShadow}
    >
      {/* Header — identity */}
      <XStack
        alignItems="center"
        gap={12}
        padding={14}
        backgroundColor={`${accent}14`}
      >
        <YStack
          width={46}
          height={46}
          borderRadius={23}
          backgroundColor={accent}
          alignItems="center"
          justifyContent="center"
        >
          <Text fontSize={17} fontWeight="700" color={palette.white}>
            {initials(patient)}
          </Text>
        </YStack>
        <YStack flex={1} gap={2}>
          <Text fontSize={18} fontWeight="700" color={palette.label} letterSpacing={-0.3}>
            {fullName(patient)}
          </Text>
          {subline ? (
            <Text fontSize={13} color={palette.secondaryLabel} letterSpacing={-0.1}>
              {subline}
            </Text>
          ) : null}
        </YStack>
        <Tag label={`Group ${patient.group}`} color={accent} />
      </XStack>

      <YStack padding={14} gap={16}>
        {/* Demographics + contact + stay */}
        <XStack flexWrap="wrap">
          <Field label="Patient ID" value={patient.id} />
          <Field label="Date of birth" value={fmtDate(patient.dob)} />
          <Field label="Ethnicity" value={patient.ethnicityDescription} />
          <Field label="Phone" value={patient.phone} />
          <Field label="Email" value={patient.email} />
          <Field label="Location" value={location || null} />
          <Field label="Admitted" value={fmtDate(patient.admissionTime)} />
          <Field label="Discharged" value={fmtDate(patient.dischargeTime)} />
          <Field
            label="Care type"
            value={
              patient.outpatient == null
                ? null
                : patient.outpatient
                  ? 'Outpatient'
                  : 'Inpatient'
            }
          />
          <Field
            label="On leave"
            value={patient.onLeave == null ? null : patient.onLeave ? 'Yes' : 'No'}
          />
        </XStack>

        <Section
          icon="pulse"
          title="Conditions"
          count={patient.conditions.length}
          accent={accent}
          emptyHint="No conditions on record"
        >
          {patient.conditions.map(conditionRow)}
        </Section>

        <Section
          icon="medkit"
          title="Medications"
          count={patient.medications.length}
          accent={accent}
          emptyHint="No medications on record"
        >
          {patient.medications.map(medicationRow)}
        </Section>

        <Section
          icon="warning"
          title="Allergies"
          count={patient.allergies.length}
          accent={accent}
          emptyHint="No known allergies"
        >
          {patient.allergies.map(allergyRow)}
        </Section>

        <Section
          icon="analytics"
          title="Observations"
          count={patient.observations.length}
          accent={accent}
          emptyHint="No observations on record"
        >
          {patient.observations.map(observationRow)}
        </Section>
      </YStack>
    </YStack>
  );
}

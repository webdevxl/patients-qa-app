// The pinned "Asking about" card — the active-scope cue shown in the ASK phase.
//
// It's the SAME patient card from the chat transcript, minimized and pinned under the nav bar so
// the scope is always legible: every question goes to ONE patient, and only that patient's records
// answer it. Following the iOS convention of putting the conversation's subject at the top
// (Messages/Mail), it stays put while the transcript scrolls.
//
// Two non-overlapping tap targets:
//   • the identity row  → opens the full record (the "expanded" form) via `onOpenRecord`
//   • the Change pill    → leaves patient scope to search for someone else via `onChange`
import React from 'react';
import { XStack, Text } from 'tamagui';
import { Ionicons } from '@expo/vector-icons';
import { palette, radius } from '../theme/palette';
import type { PatientDetail } from '../api/client';

function fullName(p: PatientDetail): string {
  return `${p.nameFirst ?? ''} ${p.nameLast ?? ''}`.trim() || 'this patient';
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

/**
 * The compact one-line summary trailing the name: cohort first (kept legible now that the standalone
 * scope banner is gone), then demographics. Record counts live in the expanded record, not here.
 */
function buildSubline(p: PatientDetail): string {
  const yrs = age(p.dob);
  return [`Group ${p.group}`, yrs != null ? `${yrs} yrs` : null, p.gender]
    .filter(Boolean)
    .join('  ·  ');
}

export function PinnedPatientCard({
  patient,
  accent,
  onOpenRecord,
  onChange,
}: {
  patient: PatientDetail;
  accent: string;
  /** Open the patient's full record (the expanded form of this card). */
  onOpenRecord: () => void;
  /** Leave patient scope and search for another patient. */
  onChange: () => void;
}) {
  const name = fullName(patient);

  return (
    // A single compact toolbar row pinned under the nav bar — ~⅓ the height of the old card. The
    // whole identity stretch opens the full record; the Change pill is its own tap target. A bottom
    // hairline divides it from the scrolling transcript below.
    <XStack
      backgroundColor={palette.surface}
      paddingHorizontal={14}
      paddingVertical={7}
      gap={8}
      alignItems="center"
      borderBottomWidth={1}
      borderBottomColor={palette.hairline}
    >
      {/* Identity — tap anywhere along it to open the full record (minimized → expanded). */}
      <XStack
        flex={1}
        alignItems="center"
        gap={7}
        onPress={onOpenRecord}
        accessibilityRole="button"
        accessibilityLabel={`View ${name}'s full record`}
        cursor="pointer"
        animation="quick"
        pressStyle={{ opacity: 0.6 }}
      >
        {/* The lock keeps the "scoped to one patient" cue the removed banner used to carry. */}
        <Ionicons name="lock-closed" size={13} color={accent} />
        <Text fontSize={14} color={palette.label} letterSpacing={-0.2} numberOfLines={1} flexShrink={1}>
          <Text fontWeight="700">{name}</Text>
          <Text fontSize={13} fontWeight="400" color={palette.secondaryLabel}>
            {`   ·   ${buildSubline(patient)}`}
          </Text>
        </Text>
        <Ionicons name="chevron-forward" size={14} color={palette.tertiaryLabel} />
      </XStack>

      <XStack
        onPress={onChange}
        accessibilityRole="button"
        accessibilityLabel="Change patient"
        alignItems="center"
        gap={4}
        paddingVertical={4}
        paddingHorizontal={9}
        borderRadius={radius.chip}
        backgroundColor={palette.secondarySystemFill}
        cursor="pointer"
        animation="quick"
        pressStyle={{ opacity: 0.7, scale: 0.97 }}
        hoverStyle={{ opacity: 0.85 }}
      >
        <Ionicons name="swap-horizontal" size={13} color={accent} />
        <Text fontSize={13} fontWeight="600" color={accent} letterSpacing={-0.2}>
          Change
        </Text>
      </XStack>
    </XStack>
  );
}

// One selectable row in the disambiguation list.
//
// When the find step returns more than one patient, the chat hides the composer and shows these
// rows — tapping one PICKS that patient (pins it by id) and moves the conversation into the
// patient-scoped Q&A phase. Two shapes:
//   • attribute-search candidates (allergic to X, on drug Y…) already have a rich compact card —
//     reuse `ConditionMatchCard`, just repurposing its tap from "open modal" to "select".
//   • identity candidates (e.g. two patients with the same name) get a lightweight identity row
//     with enough demographics (age · gender · group) to tell them apart.
import React from 'react';
import { XStack, YStack, Text } from 'tamagui';
import { Ionicons } from '@expo/vector-icons';
import { palette, radius, cardShadow } from '../theme/palette';
import type { PatientDetail, CandidateItem } from '../api/client';
import { ConditionMatchCard } from './ConditionMatchCard';

// Re-exported so screens can import the row + its item type from one place.
export type { CandidateItem };

function fullName(p: PatientDetail): string {
  return `${p.nameFirst ?? ''} ${p.nameLast ?? ''}`.trim() || 'Unknown patient';
}

function initials(p: PatientDetail): string {
  const a = p.nameFirst?.[0] ?? '';
  const b = p.nameLast?.[0] ?? '';
  return (a + b).toUpperCase() || '?';
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

export function CandidateRow({
  item,
  accent,
  onPress,
}: {
  item: CandidateItem;
  accent: string;
  onPress: () => void;
}) {
  // Attribute candidates: reuse the existing compact match card, repurposing the tap to select.
  if (item.match) {
    return <ConditionMatchCard match={item.match} accent={accent} onPress={onPress} />;
  }

  const p = item.patient;
  const yrs = age(p.dob);
  const sub = [p.gender, yrs != null ? `${yrs} yrs` : null, `Group ${p.group}`]
    .filter(Boolean)
    .join('  ·  ');

  return (
    <XStack
      marginHorizontal={16}
      marginTop={8}
      padding={12}
      gap={12}
      alignItems="center"
      backgroundColor={palette.surface}
      borderRadius={radius.card}
      borderWidth={1}
      borderColor={palette.hairline}
      style={cardShadow}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Select ${fullName(p)}`}
      cursor="pointer"
      animation="quick"
      pressStyle={{ opacity: 0.9, scale: 0.99 }}
    >
      <YStack
        width={40}
        height={40}
        borderRadius={20}
        backgroundColor={accent}
        alignItems="center"
        justifyContent="center"
      >
        <Text fontSize={15} fontWeight="700" color={palette.white}>
          {initials(p)}
        </Text>
      </YStack>

      <YStack flex={1} gap={2}>
        <Text
          fontSize={15}
          fontWeight="700"
          color={palette.label}
          letterSpacing={-0.2}
          numberOfLines={1}
        >
          {fullName(p)}
        </Text>
        {sub ? (
          <Text fontSize={13} color={palette.secondaryLabel} letterSpacing={-0.1} numberOfLines={1}>
            {sub}
          </Text>
        ) : null}
      </YStack>

      <Ionicons name="chevron-forward" size={18} color={palette.tertiaryLabel} />
    </XStack>
  );
}

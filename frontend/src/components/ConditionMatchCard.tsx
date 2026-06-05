// Compact result widget for the semantic condition search (find_patients_by_condition).
//
// Unlike PatientCard (the full record for a single resolved patient), a condition search
// returns many patients at once — so each is shown as a small, scannable card: who they are
// and the single ICD-10 diagnosis they matched on, with a confidence badge. Deliberately
// short — drill into any patient by asking about them by name.
import React from 'react';
import { XStack, YStack, Text } from 'tamagui';
import { Ionicons } from '@expo/vector-icons';
import { palette, radius, cardShadow } from '../theme/palette';
import type { ConditionMatch } from '../api/client';
import type { Confidence } from './MessageBubble';

const confidenceColor: Record<Confidence, string> = {
  High: palette.green,
  Medium: palette.orange,
  Low: palette.red,
};

/** First + last initial from a "First Last" string. */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const a = parts[0]?.[0] ?? '';
  const b = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (a + b).toUpperCase() || '?';
}

export function ConditionMatchCard({
  match,
  accent,
  onPress,
}: {
  match: ConditionMatch;
  accent: string;
  /** Tap to expand into the full patient record (opens PatientDetailModal). */
  onPress?: () => void;
}) {
  const { patient, matchedCondition: c, confidence } = match;
  const cc = confidenceColor[confidence];
  const displayName =
    `${patient.nameFirst ?? ''} ${patient.nameLast ?? ''}`.trim() ||
    'Unknown patient';
  const group = patient.group;

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
      accessibilityLabel={`View full record for ${displayName}`}
      cursor="pointer"
      animation="quick"
      pressStyle={{ opacity: 0.9, scale: 0.99 }}
    >
      {/* Avatar */}
      <YStack
        width={40}
        height={40}
        borderRadius={20}
        backgroundColor={accent}
        alignItems="center"
        justifyContent="center"
      >
        <Text fontSize={15} fontWeight="700" color={palette.white}>
          {initials(displayName)}
        </Text>
      </YStack>

      {/* Identity + matched diagnosis */}
      <YStack flex={1} gap={3}>
        <XStack alignItems="center" gap={8}>
          <Text
            flex={1}
            fontSize={15}
            fontWeight="700"
            color={palette.label}
            letterSpacing={-0.2}
            numberOfLines={1}
          >
            {displayName}
          </Text>
          <XStack
            paddingHorizontal={8}
            paddingVertical={3}
            borderRadius={radius.chip}
            backgroundColor={`${cc}1A`}
          >
            <Text fontSize={11} fontWeight="700" color={cc}>
              {confidence}
            </Text>
          </XStack>
        </XStack>

        <XStack alignItems="center" gap={6}>
          <Ionicons name="pulse" size={13} color={accent} />
          <Text fontSize={13} fontWeight="700" color={palette.label}>
            {c.icd10Code}
          </Text>
          <Text
            flex={1}
            fontSize={13}
            color={palette.secondaryLabel}
            letterSpacing={-0.1}
            numberOfLines={1}
          >
            {c.icd10Description}
          </Text>
          <Text fontSize={12} color={palette.tertiaryLabel}>
            Group {group}
          </Text>
        </XStack>
      </YStack>

      {/* Affordance: tap to open the full record */}
      <Ionicons name="chevron-forward" size={18} color={palette.tertiaryLabel} />
    </XStack>
  );
}

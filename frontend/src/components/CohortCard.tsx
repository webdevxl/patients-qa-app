// Selectable cohort card for the picker.
//
// Unselected: white surface, soft shadow, chevron affordance.
// Selected:   accent border + faint cohort tint wash + filled checkmark, and the
//             whole surface picks up the cohort color. Making the entire card adopt
//             the cohort identity (not just a small dot) reinforces, at a glance,
//             which boundary you're about to enter.
import React from 'react';
import { XStack, YStack, Text } from 'tamagui';
import { Ionicons } from '@expo/vector-icons';
import {
  palette,
  radius,
  cardShadow,
  accentShadow,
  cohortTheme,
} from '../theme/palette';
import type { CohortMeta } from '../domain/cohorts';

interface CohortCardProps {
  meta: CohortMeta;
  selected: boolean;
  onPress: () => void;
}

export function CohortCard({ meta, selected, onPress }: CohortCardProps) {
  const theme = cohortTheme[meta.group];
  return (
    <XStack
      onPress={onPress}
      accessibilityRole="radio"
      aria-checked={selected}
      accessibilityLabel={meta.label}
      animation="quick"
      pressStyle={{ scale: 0.98 }}
      cursor="pointer"
      alignItems="center"
      gap={14}
      padding={16}
      borderRadius={radius.card}
      borderWidth={selected ? 2 : 1}
      borderColor={selected ? theme.accent : palette.hairline}
      backgroundColor={selected ? theme.tint : palette.surface}
      style={selected ? accentShadow(theme.accent) : cardShadow}
    >
      {/* Cohort mark */}
      <YStack
        width={52}
        height={52}
        borderRadius={16}
        alignItems="center"
        justifyContent="center"
        backgroundColor={theme.accent}
      >
        <Ionicons name={meta.icon} size={28} color={theme.onAccent} />
      </YStack>

      {/* Title + meta */}
      <YStack flex={1} gap={3}>
        <Text fontSize={20} fontWeight="700" color={palette.label} letterSpacing={-0.4}>
          {meta.label}
        </Text>
        <Text fontSize={14} color={palette.secondaryLabel} letterSpacing={-0.1}>
          {meta.caption}
        </Text>
      </YStack>

      {/* Selection indicator */}
      {selected ? (
        <Ionicons name="checkmark-circle" size={26} color={theme.accent} />
      ) : (
        <Ionicons name="chevron-forward" size={20} color={palette.tertiaryLabel} />
      )}
    </XStack>
  );
}

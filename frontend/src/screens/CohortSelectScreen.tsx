// First-run screen: choose the cohort you'll work inside.
//
// This is step #1 of the product flow and the UI face of the app's core safety
// rule — you operate inside exactly one cohort, chosen deliberately, before any
// patient data is ever requested. Selection is a two-beat interaction (pick a card,
// then confirm) so entering a cohort boundary is never an accidental single tap.
import React, { useState } from 'react';
import { ScrollView, YStack, XStack, Text } from 'tamagui';
import { Ionicons } from '@expo/vector-icons';
import { Screen } from '../components/Screen';
import { CohortCard } from '../components/CohortCard';
import { PrimaryButton } from '../components/PrimaryButton';
import { COHORTS, cohortMeta } from '../domain/cohorts';
import { cohortTheme, palette } from '../theme/palette';
import type { CohortGroup } from '../theme/palette';

interface CohortSelectScreenProps {
  onSelect: (group: CohortGroup) => void;
}

export function CohortSelectScreen({ onSelect }: CohortSelectScreenProps) {
  const [pending, setPending] = useState<CohortGroup | null>(null);

  return (
    <Screen>
      <ScrollView
        flex={1}
        contentContainerStyle={{
          paddingHorizontal: 20,
          paddingTop: 24,
          paddingBottom: 24,
          flexGrow: 1,
        }}
        showsVerticalScrollIndicator={false}
      >
        {/* App mark */}
        <YStack
          width={56}
          height={56}
          borderRadius={16}
          alignItems="center"
          justifyContent="center"
          backgroundColor={palette.blue}
          marginBottom={20}
        >
          <Ionicons name="medkit" size={30} color={palette.white} />
        </YStack>

        {/* Title block — iOS large-title scale */}
        <Text fontSize={34} fontWeight="800" color={palette.label} letterSpacing={-0.8}>
          Patient Q&A
        </Text>
        <Text
          fontSize={17}
          color={palette.secondaryLabel}
          marginTop={6}
          letterSpacing={-0.2}
        >
          Choose a cohort to begin. Every answer stays scoped to the group you
          select.
        </Text>

        {/* Safety reassurance — ties the picker to the app's central invariant */}
        <XStack
          alignItems="center"
          gap={8}
          marginTop={16}
          marginBottom={28}
          paddingVertical={10}
          paddingHorizontal={12}
          borderRadius={12}
          backgroundColor="rgba(52,199,89,0.10)"
        >
          <Ionicons name="shield-checkmark" size={16} color={palette.green} />
          <Text fontSize={13} color="#1F8B3B" fontWeight="500" flex={1} letterSpacing={-0.1}>
            Records from other cohorts are never accessible in this session.
          </Text>
        </XStack>

        {/* Cohort cards */}
        <YStack gap={14}>
          {COHORTS.map((meta) => (
            <CohortCard
              key={meta.group}
              meta={meta}
              selected={pending === meta.group}
              onPress={() => setPending(meta.group)}
            />
          ))}
        </YStack>

        {/* Spacer pushes the CTA toward the bottom on tall screens */}
        <YStack flex={1} minHeight={24} />

        {/* Confirm */}
        <PrimaryButton
          label={pending ? `Continue as ${cohortMeta(pending).label}` : 'Select a cohort'}
          onPress={() => pending && onSelect(pending)}
          disabled={!pending}
          color={pending ? cohortTheme[pending].accent : undefined}
          iconAfter="arrow-forward"
        />
        <Text
          fontSize={12}
          color={palette.tertiaryLabel}
          textAlign="center"
          marginTop={14}
          letterSpacing={-0.1}
        >
          Read-only clinical prototype · records are never modified
        </Text>
      </ScrollView>
    </Screen>
  );
}

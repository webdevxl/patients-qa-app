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
import { Logo } from '../components/Logo';
import { COHORTS, cohortMeta } from '../domain/cohorts';
import { cohortTheme, palette } from '../theme/palette';
import type { CohortGroup } from '../theme/palette';

interface CohortSelectScreenProps {
  /** Exchange the chosen cohort for a session token. Rejects if the backend is unreachable. */
  onSelect: (group: CohortGroup) => Promise<void>;
}

export function CohortSelectScreen({ onSelect }: CohortSelectScreenProps) {
  const [pending, setPending] = useState<CohortGroup | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    if (!pending || submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      // On success the app swaps to the chat screen, unmounting this one — no need to reset state.
      await onSelect(pending);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : 'Could not start a session. Please try again.',
      );
      setSubmitting(false);
    }
  };

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
        {/* Brand header — logo on the same line as the app name + subtitle */}
        <XStack alignItems="center" gap={14}>
          <Logo size={42} color={palette.primary} />
          <YStack flex={1} gap={3}>
            <Text fontSize={26} fontWeight="800" color={palette.label} letterSpacing={-0.6}>
              Patient Q&A
            </Text>
            <Text fontSize={14} color={palette.secondaryLabel} letterSpacing={-0.1}>
              Choose a cohort to begin. Every answer stays scoped to the group you
              select.
            </Text>
          </YStack>
        </XStack>

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
              onPress={() => !submitting && setPending(meta.group)}
            />
          ))}
        </YStack>

        {/* Spacer pushes the CTA toward the bottom on tall screens */}
        <YStack flex={1} minHeight={24} />

        {/* Connection error (e.g. backend unreachable) — clears on the next attempt */}
        {error ? (
          <XStack
            alignItems="center"
            gap={8}
            marginBottom={12}
            paddingVertical={10}
            paddingHorizontal={12}
            borderRadius={12}
            backgroundColor="rgba(255,59,48,0.10)"
          >
            <Ionicons name="alert-circle" size={16} color={palette.red} />
            <Text fontSize={13} color={palette.red} fontWeight="500" flex={1} letterSpacing={-0.1}>
              {error}
            </Text>
          </XStack>
        ) : null}

        {/* Confirm */}
        <PrimaryButton
          label={pending ? `Continue as ${cohortMeta(pending).label}` : 'Select a cohort'}
          onPress={confirm}
          disabled={!pending}
          loading={submitting}
          gradient={pending ? cohortTheme[pending].gradient : undefined}
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

// Footer strip that surfaces token usage for the chat session — sits directly above the composer.
//
// The backend returns best-effort per-request usage (`QaResult.usage`); ChatScreen accumulates it
// across turns into `SessionUsage` and passes it here. We show two things at a glance: the running
// total of tokens this conversation has spent, and how full the context is (the latest turn's input
// tokens as a % of the backend's tunable `contextWindow` budget). Tapping the row expands an
// input/output/turns/model breakdown.
//
// Brand note: numbers use `$mono` (Geist Mono) per the citation/code convention, but never with
// fontWeight > 500 — only the Regular weight is loaded, so heavier weights would faux-bold on web.
import React, { useState } from 'react';
import { YStack, XStack, Text } from 'tamagui';
import { Ionicons } from '@expo/vector-icons';
import { Chip } from './Chip';
import { palette, radius } from '../theme/palette';

/** Cumulative token accounting for the chat session, accumulated in ChatScreen across turns. */
export interface SessionUsage {
  cumulativeInput: number;
  cumulativeOutput: number;
  cumulativeTotal: number;
  /** Number of model-backed turns counted (find/answer calls; pure selections don't count). */
  turns: number;
  /** Latest turn's input tokens = the current context size charted against `contextWindow`. */
  lastContextTokens: number;
  /** The backend's context-window budget (its own tunable constant), from the latest usage. */
  contextWindow: number;
  /** Resolved chat model name from the latest usage. */
  model: string;
}

/** Zero state before the first model-backed turn. `contextWindow`/`model` are placeholders until a
 *  real usage payload arrives and overwrites them. */
export const ZERO_USAGE: SessionUsage = {
  cumulativeInput: 0,
  cumulativeOutput: 0,
  cumulativeTotal: 0,
  turns: 0,
  lastContextTokens: 0,
  contextWindow: 100_000,
  model: '',
};

/** "12345" → "12,345" — grouped without relying on Intl (Hermes lacks full toLocaleString). */
const fmt = (n: number): string =>
  Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** "100000" → "100K" for the compact context-window label. */
const formatCompact = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}K` : String(n));

interface TokenUsageBarProps {
  usage: SessionUsage;
  /** Active cohort accent — colors the icon and the meter fill, matching the rest of the chat. */
  accent: string;
}

export function TokenUsageBar({ usage, accent }: TokenUsageBarProps) {
  const [expanded, setExpanded] = useState(false);
  const hasData = usage.turns > 0;

  // Context fullness = latest turn's input tokens vs. the budget. Round for display, but show "<1"
  // (not "0") for a real-but-tiny context, and floor the rendered bar at 2% so any spend is visible.
  const pctRaw =
    usage.contextWindow > 0 ? (usage.lastContextTokens / usage.contextWindow) * 100 : 0;
  const pct = Math.round(pctRaw);
  const pctLabel = usage.lastContextTokens > 0 && pct === 0 ? '<1' : String(pct);
  const barWidth = hasData ? Math.max(2, Math.min(100, pct)) : 0;

  return (
    <YStack
      backgroundColor={palette.surface}
      borderTopWidth={1}
      borderTopColor={palette.hairline}
      paddingHorizontal={16}
      paddingTop={8}
      paddingBottom={8}
      gap={6}
    >
      {/* Header row — tap to expand/collapse the breakdown. */}
      <XStack
        alignItems="center"
        gap={6}
        onPress={() => setExpanded((e) => !e)}
        accessibilityRole="button"
        accessibilityLabel={
          hasData
            ? `Token usage: ${fmt(usage.cumulativeTotal)} tokens total, context ${pctLabel}% of ${formatCompact(usage.contextWindow)}. Tap to ${expanded ? 'collapse' : 'expand'} details.`
            : 'Token usage: no turns yet'
        }
        animation="quick"
        pressStyle={{ opacity: 0.6 }}
        cursor="pointer"
      >
        <Ionicons
          name="stats-chart"
          size={15}
          color={hasData ? accent : palette.tertiaryLabel}
        />
        <Text fontSize={12} fontWeight="600" color={palette.secondaryLabel} letterSpacing={0.2}>
          Token usage
        </Text>

        <XStack flex={1} />

        {hasData ? (
          <XStack alignItems="center" gap={4}>
            <Text fontFamily="$mono" fontSize={13} color={palette.label}>
              {fmt(usage.cumulativeTotal)}
            </Text>
            <Text fontSize={11} color={palette.tertiaryLabel}>
              tokens
            </Text>
          </XStack>
        ) : (
          <Text fontSize={13} color={palette.tertiaryLabel}>
            —
          </Text>
        )}

        <Ionicons
          name={expanded ? 'chevron-up' : 'chevron-down'}
          size={14}
          color={palette.tertiaryLabel}
        />
      </XStack>

      {/* Context-window meter — the headline visual, always shown. */}
      <YStack gap={4}>
        <XStack justifyContent="space-between" alignItems="center">
          <Text fontSize={11} color={palette.tertiaryLabel}>
            Context
          </Text>
          <Text fontFamily="$mono" fontSize={11} color={palette.secondaryLabel}>
            {hasData ? `${pctLabel}% of ${formatCompact(usage.contextWindow)}` : 'No turns yet'}
          </Text>
        </XStack>
        <YStack
          height={6}
          borderRadius={radius.chip}
          backgroundColor={palette.tertiarySystemFill}
          overflow="hidden"
        >
          <YStack
            height={6}
            borderRadius={radius.chip}
            width={`${barWidth}%`}
            backgroundColor={accent}
          />
        </YStack>
      </YStack>

      {/* Expanded breakdown — input/output split, turn count, model. */}
      {expanded && hasData ? (
        <XStack flexWrap="wrap" gap={8} marginTop={2}>
          <Chip size="sm" icon="arrow-down-outline" label={`In ${fmt(usage.cumulativeInput)}`} />
          <Chip size="sm" icon="arrow-up-outline" label={`Out ${fmt(usage.cumulativeOutput)}`} />
          <Chip
            size="sm"
            icon="chatbubbles-outline"
            label={`${usage.turns} ${usage.turns === 1 ? 'turn' : 'turns'}`}
          />
          {usage.model ? (
            <Chip size="sm" icon="hardware-chip-outline" label={usage.model} />
          ) : null}
        </XStack>
      ) : null}
    </YStack>
  );
}

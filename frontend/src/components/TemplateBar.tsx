// Always-on EVAL-DATASET strip rendered directly above the composer. It surfaces the curated
// evaluation prompts for the *current* phase (find-patient vs answer-patient) across the four eval
// categories — `normal`, `prompt_injection`, `cross_cohort`, `insufficient_context` — with a
// horizontally-scrollable category selector. Tapping a pill drops its full text into the composer
// (via `onSelect`) AND reports the chip's category up so the next send is tagged with it; it never
// sends on its own. The tag lets the backend score per-category behaviour (the admin scorecard).
import React from 'react';
import { ScrollView, XStack, YStack, Text } from 'tamagui';
import { Ionicons } from '@expo/vector-icons';
import type { AgentName } from '../api/client';
import { EVAL_DATASET, type EvalCategory } from '../domain/promptTemplates';
import { palette, radius } from '../theme/palette';

interface TemplateBarProps {
  /** Current phase's agent — drives which template set is shown. */
  agent: AgentName;
  /** The selected category tab — drives which ten prompts are shown. */
  category: EvalCategory;
  onCategoryChange: (c: EvalCategory) => void;
  /** Load a prompt's full text into the composer and tag the next send with its category. */
  onSelect: (text: string, category: EvalCategory) => void;
  accent: string;
}

// Per-category presentation: a foreground (text/icon/active fill), a faint tint for pill fills, the
// chip icon, a short tab label, and the one-line caption that primes the expected behaviour.
const CATEGORY: Record<
  EvalCategory,
  {
    fg: string;
    tint: string;
    border: string;
    icon: keyof typeof Ionicons.glyphMap;
    label: string;
    caption: string;
  }
> = {
  normal: {
    fg: palette.green,
    tint: 'rgba(52,199,89,0.12)',
    border: 'rgba(52,199,89,0.45)',
    icon: 'medkit',
    label: 'Normal',
    caption: 'Ordinary in-cohort questions — expect a grounded answer.',
  },
  prompt_injection: {
    fg: palette.red,
    tint: 'rgba(224,96,112,0.12)',
    border: 'rgba(224,96,112,0.45)',
    icon: 'warning',
    label: 'Injection',
    caption: 'Crafted to trip the guard — expect a refusal.',
  },
  cross_cohort: {
    fg: palette.orange,
    tint: 'rgba(255,149,0,0.12)',
    border: 'rgba(255,149,0,0.45)',
    icon: 'git-compare',
    label: 'Cross-cohort',
    caption: 'Reach another cohort — expect a refusal or no-match.',
  },
  insufficient_context: {
    fg: palette.teal,
    tint: 'rgba(48,176,199,0.12)',
    border: 'rgba(48,176,199,0.45)',
    icon: 'help-circle',
    label: 'No-context',
    caption: 'Unsupported by the records — expect the safe fallback.',
  },
};

// Stable left-to-right order for the selector (matches the eval write-up: normal first, then the
// three "should be refused / fallback" categories).
const CATEGORY_ORDER: EvalCategory[] = [
  'normal',
  'prompt_injection',
  'cross_cohort',
  'insufficient_context',
];

const AGENT_LABEL: Record<AgentName, string> = {
  'find-patient': 'FIND PATIENT',
  'answer-patient': 'ASK PATIENT',
};

function CategorySegment({
  label,
  icon,
  active,
  color,
  onPress,
}: {
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  active: boolean;
  color: string;
  onPress: () => void;
}) {
  return (
    <XStack
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      animation="quick"
      pressStyle={{ opacity: 0.7 }}
      cursor="pointer"
      alignItems="center"
      gap={4}
      paddingHorizontal={9}
      paddingVertical={4}
      borderRadius={radius.chip}
      backgroundColor={active ? color : 'transparent'}
    >
      <Ionicons name={icon} size={12} color={active ? palette.white : palette.secondaryLabel} />
      <Text fontSize={12} fontWeight="600" color={active ? palette.white : palette.secondaryLabel}>
        {label}
      </Text>
    </XStack>
  );
}

export function TemplateBar({ agent, category, onCategoryChange, onSelect, accent }: TemplateBarProps) {
  const c = CATEGORY[category];
  const prompts = EVAL_DATASET[agent][category];

  return (
    <YStack
      paddingHorizontal={16}
      paddingTop={8}
      paddingBottom={6}
      gap={6}
      backgroundColor={palette.systemGroupedBackground}
      borderTopWidth={1}
      borderTopColor={palette.hairline}
    >
      {/* Header: phase label. */}
      <Text fontSize={12} fontWeight="600" color={palette.tertiaryLabel} letterSpacing={0.2}>
        {AGENT_LABEL[agent]} · EVAL DATASET
      </Text>

      {/* Category selector — one segmented control, horizontally scrollable (four won't fit on a
          narrow phone). The active segment fills with its category color. */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <XStack
          borderRadius={radius.chip}
          backgroundColor={palette.tertiarySystemFill}
          padding={2}
          gap={2}
        >
          {CATEGORY_ORDER.map((key) => (
            <CategorySegment
              key={key}
              label={CATEGORY[key].label}
              icon={CATEGORY[key].icon}
              active={category === key}
              color={CATEGORY[key].fg}
              onPress={() => onCategoryChange(key)}
            />
          ))}
        </XStack>
      </ScrollView>

      {/* One scrollable row of short-labelled pills — tap to load into the composer (tagged). */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <XStack gap={8} paddingRight={16}>
          {prompts.map((t) => (
            <XStack
              key={t.id}
              onPress={() => onSelect(t.text, category)}
              accessibilityRole="button"
              accessibilityLabel={t.text}
              animation="quick"
              pressStyle={{ scale: 0.97, opacity: 0.8 }}
              cursor="pointer"
              alignItems="center"
              gap={5}
              paddingHorizontal={11}
              paddingVertical={6}
              borderRadius={radius.chip}
              backgroundColor={c.tint}
              borderWidth={1}
              borderColor={c.border}
            >
              <Ionicons name={c.icon} size={13} color={c.fg} />
              <Text fontSize={13} fontWeight="500" color={palette.label} letterSpacing={-0.1}>
                {t.label}
              </Text>
            </XStack>
          ))}
        </XStack>
      </ScrollView>

      {/* Caption — primes the expected behaviour for the selected category. */}
      <XStack alignItems="center" gap={5}>
        <Ionicons name={c.icon} size={12} color={c.fg} />
        <Text fontSize={11} color={palette.secondaryLabel}>
          {c.caption}
        </Text>
      </XStack>
    </YStack>
  );
}

// Always-on prompt-template strip rendered directly above the composer. It surfaces curated
// example prompts for the *current* phase (find-patient vs answer-patient) in two variants —
// `safe` (ordinary questions) and `dangerous` (crafted to trip the safety guard) — with a
// segmented toggle to switch between them. Tapping a pill drops its full text into the composer
// (via `onSelect`) so the clinician can review before sending; it never sends on its own.
import React from 'react';
import { ScrollView, XStack, YStack, Text } from 'tamagui';
import { Ionicons } from '@expo/vector-icons';
import type { AgentName } from '../api/client';
import { PROMPT_TEMPLATES, type TemplateVariant } from '../domain/promptTemplates';
import { palette, radius } from '../theme/palette';

interface TemplateBarProps {
  /** Current phase's agent — drives which template set is shown. */
  agent: AgentName;
  variant: TemplateVariant;
  onVariantChange: (v: TemplateVariant) => void;
  /** Load a template's full text into the composer. */
  onSelect: (text: string) => void;
  accent: string;
}

// Per-variant palette: a foreground (text/icon/active fill) and a faint tint for pill fills.
const VARIANT = {
  safe: { fg: palette.green, tint: 'rgba(52,199,89,0.12)', border: 'rgba(52,199,89,0.45)' },
  dangerous: { fg: palette.red, tint: 'rgba(224,96,112,0.12)', border: 'rgba(224,96,112,0.45)' },
} as const;

const AGENT_LABEL: Record<AgentName, string> = {
  'find-patient': 'FIND PATIENT',
  'answer-patient': 'ASK PATIENT',
};

function VariantSegment({
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

export function TemplateBar({ agent, variant, onVariantChange, onSelect, accent }: TemplateBarProps) {
  const v = VARIANT[variant];
  const templates = PROMPT_TEMPLATES[agent][variant];

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
      {/* Header: phase label + Safe ⇄ Dangerous segmented toggle. */}
      <XStack alignItems="center" justifyContent="space-between" gap={8}>
        <Text fontSize={12} fontWeight="600" color={palette.tertiaryLabel} letterSpacing={0.2}>
          {AGENT_LABEL[agent]} · TEMPLATES
        </Text>
        <XStack
          borderRadius={radius.chip}
          backgroundColor={palette.tertiarySystemFill}
          padding={2}
          gap={2}
        >
          <VariantSegment
            label="Safe"
            icon="shield-checkmark"
            active={variant === 'safe'}
            color={VARIANT.safe.fg}
            onPress={() => onVariantChange('safe')}
          />
          <VariantSegment
            label="Dangerous"
            icon="warning"
            active={variant === 'dangerous'}
            color={VARIANT.dangerous.fg}
            onPress={() => onVariantChange('dangerous')}
          />
        </XStack>
      </XStack>

      {/* One scrollable row of short-labelled pills — tap to load into the composer. */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <XStack gap={8} paddingRight={16}>
          {templates.map((t) => (
            <XStack
              key={t.id}
              onPress={() => onSelect(t.text)}
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
              backgroundColor={v.tint}
              borderWidth={1}
              borderColor={v.border}
            >
              <Ionicons
                name={variant === 'safe' ? 'medkit' : 'warning'}
                size={13}
                color={v.fg}
              />
              <Text fontSize={13} fontWeight="500" color={palette.label} letterSpacing={-0.1}>
                {t.label}
              </Text>
            </XStack>
          ))}
        </XStack>
      </ScrollView>

      {/* Caption — clarifies the dangerous set's intent so nobody mistakes it for a real query. */}
      {variant === 'dangerous' ? (
        <XStack alignItems="center" gap={5}>
          <Ionicons name="alert-circle" size={12} color={palette.red} />
          <Text fontSize={11} color={palette.secondaryLabel}>
            These are crafted to trip the safety guard — expect a refusal.
          </Text>
        </XStack>
      ) : null}
    </YStack>
  );
}

// THE patient card — one compact, consistent card shown in chat for every find result, whether the
// search resolved a single patient or many. It replaces the old split between `ConditionMatchCard`
// (search hits) and `CandidateRow` (disambiguation) so results never read differently depending on
// how the patient was found.
//
// Every card carries the same information, in the same place:
//   • identity — avatar, name, age · gender
//   • cohort — the Group chip (the safety invariant, always visible)
//   • confidence — High/Medium/Low badge (search similarity, or "High" for an exact name/ID hit)
//   • the WHOLE record at a glance — counts of conditions / medications / allergies / observations,
//     so a card never shows only the drug (or only the allergy) it happened to match on
//   • a "matched on" highlight — when an attribute search surfaced them, what they matched
//
// Two explicit actions live in the footer (iOS two-button pattern: one secondary, one primary):
//   • View record → opens the full record in a modal (`onDetails`)
//   • Ask         → hands this patient to the Q&A agent (`onAsk`)
// A button renders only when its handler is supplied.
import React from 'react';
import { XStack, YStack, Text } from 'tamagui';
import { Ionicons } from '@expo/vector-icons';
import { palette, radius, cardShadow } from '../theme/palette';
import type { PatientDetail, ConditionMatch } from '../api/client';
import type { Confidence } from './MessageBubble';

const confidenceColor: Record<Confidence, string> = {
  High: palette.green,
  Medium: palette.orange,
  Low: palette.red,
};

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

// ───────────────────────── "matched on" highlight ─────────────────────────

interface Highlight {
  icon: keyof typeof Ionicons.glyphMap;
  primary: string;
  secondary?: string | null;
  narcotic?: boolean;
}

/**
 * What an attribute search surfaced this patient on. Exactly one of the `matched*` fields is set
 * per `ConditionMatch`; identity resolutions (by name / ID) carry no match and return `null`.
 */
function matchHighlight(match?: ConditionMatch): Highlight | null {
  if (!match) return null;
  if (match.matchedCondition) {
    return {
      icon: 'pulse',
      primary: match.matchedCondition.icd10Code,
      secondary: match.matchedCondition.icd10Description,
    };
  }
  if (match.matchedAllergy) {
    return {
      icon: 'medkit',
      primary: match.matchedAllergy.canonicalName,
      secondary: match.matchedAllergy.category ?? 'Allergy',
    };
  }
  if (match.matchedObservation) {
    const o = match.matchedObservation;
    return {
      icon: 'analytics',
      primary: `${o.value}${o.unit ? ` ${o.unit}` : ''}`,
      secondary: `${o.metric}${o.component ? ` (${o.component})` : ''}`,
    };
  }
  if (match.matchedMedication) {
    const m = match.matchedMedication;
    return {
      icon: 'medical',
      primary: m.description ?? m.genericName ?? 'Medication',
      secondary: m.directions,
      narcotic: m.narcotic ?? false,
    };
  }
  return null;
}

// ───────────────────────── building blocks ─────────────────────────

/** One record-count chip in the at-a-glance summary; dimmed when the patient has none. */
function CountChip({
  icon,
  count,
  label,
  accent,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  count: number;
  label: string;
  accent: string;
}) {
  const empty = count === 0;
  const fg = empty ? palette.tertiaryLabel : palette.secondaryLabel;
  return (
    <XStack
      alignItems="center"
      gap={5}
      paddingHorizontal={9}
      paddingVertical={5}
      borderRadius={radius.chip}
      backgroundColor={palette.tertiarySystemFill}
      opacity={empty ? 0.55 : 1}
    >
      <Ionicons name={icon} size={12} color={empty ? palette.tertiaryLabel : accent} />
      <Text fontSize={12} fontWeight="700" color={fg} letterSpacing={-0.1}>
        {count}
      </Text>
      <Text fontSize={12} color={fg} letterSpacing={-0.1}>
        {label}
      </Text>
    </XStack>
  );
}

/** One footer action — a flex pill. `variant` sets the iOS primary/secondary treatment. */
function CardAction({
  icon,
  label,
  onPress,
  accent,
  variant,
  disabled,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  accent: string;
  variant: 'primary' | 'secondary';
  /** Inert + dimmed: ignores presses and drops the cursor/press affordances. */
  disabled?: boolean;
}) {
  const primary = variant === 'primary';
  const fg = primary ? palette.white : palette.label;
  return (
    <XStack
      flex={1}
      height={40}
      borderRadius={radius.control}
      alignItems="center"
      justifyContent="center"
      gap={6}
      backgroundColor={primary ? accent : palette.secondarySystemFill}
      opacity={disabled ? 0.4 : 1}
      disabled={disabled}
      onPress={disabled ? undefined : onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      cursor={disabled ? 'default' : 'pointer'}
      animation="quick"
      pressStyle={disabled ? undefined : { opacity: 0.85, scale: 0.98 }}
    >
      <Ionicons name={icon} size={16} color={fg} />
      <Text fontSize={15} fontWeight="600" color={fg} letterSpacing={-0.2}>
        {label}
      </Text>
    </XStack>
  );
}

// ───────────────────────── the card ─────────────────────────

export function PatientSummaryCard({
  patient,
  accent,
  match,
  onDetails,
  onAsk,
}: {
  patient: PatientDetail;
  accent: string;
  /** Attribute-search context (condition/allergy/medication/observation) — drives the highlight. */
  match?: ConditionMatch;
  /** Open the full record in a modal. Omit to hide the "View record" button. */
  onDetails?: () => void;
  /** Hand this patient to the Q&A agent. Omit to hide the "Ask" button. */
  onAsk?: () => void;
  /** Another patient is already pinned — keep Ask visible but inert so the chat stays scoped. */
  askDisabled?: boolean;
}) {
  const yrs = age(patient.dob);
  const subline = [yrs != null ? `${yrs} yrs` : null, patient.gender]
    .filter(Boolean)
    .join('  ·  ');

  // An exact name/ID resolution carries no similarity score — but it IS an exact hit, so "High".
  const confidence: Confidence = match?.confidence ?? 'High';
  const cc = confidenceColor[confidence];

  const highlight = matchHighlight(match);
  const hasFooter = !!onDetails || !!onAsk;

  return (
    <YStack
      marginHorizontal={16}
      marginTop={8}
      backgroundColor={palette.surface}
      borderRadius={radius.card}
      borderWidth={1}
      borderColor={palette.hairline}
      overflow="hidden"
      style={cardShadow}
    >
      {/* Header — identity + cohort + confidence */}
      <XStack alignItems="center" gap={12} paddingHorizontal={14} paddingTop={14}>
        <YStack
          width={44}
          height={44}
          borderRadius={22}
          backgroundColor={accent}
          alignItems="center"
          justifyContent="center"
        >
          <Text fontSize={16} fontWeight="700" color={palette.white}>
            {initials(patient)}
          </Text>
        </YStack>

        <YStack flex={1} gap={2}>
          <Text
            fontSize={16}
            fontWeight="700"
            color={palette.label}
            letterSpacing={-0.3}
            numberOfLines={1}
          >
            {fullName(patient)}
          </Text>
          {subline ? (
            <Text fontSize={13} color={palette.secondaryLabel} letterSpacing={-0.1}>
              {subline}
            </Text>
          ) : null}
        </YStack>

        <YStack alignItems="flex-end" gap={5}>
          <XStack
            paddingHorizontal={8}
            paddingVertical={3}
            borderRadius={radius.chip}
            backgroundColor={`${accent}14`}
          >
            <Text fontSize={11} fontWeight="700" color={accent} letterSpacing={-0.1}>
              Group {patient.group}
            </Text>
          </XStack>
          <XStack
            alignItems="center"
            gap={4}
            paddingHorizontal={8}
            paddingVertical={3}
            borderRadius={radius.chip}
            backgroundColor={`${cc}1A`}
          >
            <YStack width={6} height={6} borderRadius={3} backgroundColor={cc} />
            <Text fontSize={11} fontWeight="700" color={cc} letterSpacing={-0.1}>
              {confidence}
            </Text>
          </XStack>
        </YStack>
      </XStack>

      {/* "Matched on" highlight — only when an attribute search surfaced them */}
      {highlight ? (
        <XStack
          alignItems="center"
          gap={8}
          marginHorizontal={14}
          marginTop={12}
          paddingHorizontal={10}
          paddingVertical={8}
          borderRadius={12}
          backgroundColor={`${accent}0F`}
        >
          <Ionicons name={highlight.icon} size={15} color={accent} />
          <Text fontSize={13} fontWeight="700" color={palette.label} letterSpacing={-0.1}>
            {highlight.primary}
          </Text>
          {highlight.secondary ? (
            <Text
              flex={1}
              fontSize={13}
              color={palette.secondaryLabel}
              letterSpacing={-0.1}
              numberOfLines={1}
            >
              {highlight.secondary}
            </Text>
          ) : (
            <YStack flex={1} />
          )}
          {highlight.narcotic ? (
            <XStack
              paddingHorizontal={6}
              paddingVertical={2}
              borderRadius={radius.chip}
              backgroundColor={`${palette.red}1A`}
            >
              <Text fontSize={10} fontWeight="700" color={palette.red}>
                Narcotic
              </Text>
            </XStack>
          ) : null}
        </XStack>
      ) : null}

      {/* Whole-record summary — the same four counts on every card */}
      <XStack flexWrap="wrap" gap={6} paddingHorizontal={14} paddingTop={12}>
        <CountChip icon="pulse" count={patient.conditions.length} label="Conditions" accent={accent} />
        <CountChip icon="medkit" count={patient.medications.length} label="Meds" accent={accent} />
        <CountChip icon="warning" count={patient.allergies.length} label="Allergies" accent={accent} />
        <CountChip icon="analytics" count={patient.observations.length} label="Obs" accent={accent} />
      </XStack>

      {/* Footer actions */}
      {hasFooter ? (
        <XStack
          gap={10}
          paddingHorizontal={14}
          paddingTop={12}
          paddingBottom={14}
          marginTop={12}
          borderTopWidth={1}
          borderTopColor={palette.hairline}
        >
          {onDetails ? (
            <CardAction
              icon="document-text-outline"
              label="View record"
              onPress={onDetails}
              accent={accent}
              variant="secondary"
            />
          ) : null}
          {onAsk ? (
            <CardAction
              icon="chatbubbles-outline"
              label="Ask"
              onPress={onAsk}
              accent={accent}
              variant="primary"
            />
          ) : null}
        </XStack>
      ) : null}
    </YStack>
  );
}

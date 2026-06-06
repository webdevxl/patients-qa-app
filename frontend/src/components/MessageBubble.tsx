// Chat message bubble.
//
// User messages sit right, filled with the active cohort accent. Assistant messages
// sit left on a white surface and can carry the structured extras the Q&A agent is
// specified to return — a confidence level and citations to specific source records
// — rendered as iOS-style chips beneath the answer.
import React from 'react';
import { XStack, YStack, Text } from 'tamagui';
import { Ionicons } from '@expo/vector-icons';
import { palette, radius, cardShadow } from '../theme/palette';
import type { AgentName, CandidateItem } from '../api/client';

export type Role = 'user' | 'assistant';
export type Confidence = 'High' | 'Medium' | 'Low';

export interface ChatMessage {
  id: string;
  role: Role;
  text: string;
  confidence?: Confidence;
  citations?: string[];
  /**
   * Find-result hits (one or many) — rendered as `PatientSummaryCard`s beneath the bubble. Each
   * carries the patient's full record plus, for attribute searches, what they matched on.
   */
  candidates?: CandidateItem[];
  /**
   * Compact one-line summary of what this answer resolved (from `QaResult.contextSummary`).
   * Not rendered — it's echoed back as this turn's `history` content so the backend extractor
   * can resolve follow-up references ("what about his allergies?") without re-sending records.
   */
  contextSummary?: string;
  /**
   * Which phase produced this message — carried into the `history` turn so the backend can scope the
   * answer-patient agent to answer-phase turns only. Optional here: the greeting and error/system
   * bubbles have no phase and never enter history. `patientId` is set on answer-phase turns.
   */
  agentName?: AgentName;
  patientId?: string;
  /** Marks the safe-fallback / system notices so they can read differently. */
  pending?: boolean;
  /**
   * True while this assistant bubble is being streamed token-by-token (the ANSWER path). Renders a
   * "Thinking…" placeholder until the first token, then a trailing caret while text grows; cleared
   * when the authoritative result finalizes the bubble.
   */
  streaming?: boolean;
}

const confidenceColor: Record<Confidence, string> = {
  High: palette.green,
  Medium: palette.orange,
  Low: palette.red,
};

export function MessageBubble({
  message,
  accent,
}: {
  message: ChatMessage;
  accent: string;
}) {
  const isUser = message.role === 'user';
  // Before the first streamed token the bubble has no text yet — show a muted placeholder; once text
  // is flowing, append a caret so it reads as actively typing.
  const showPlaceholder = !isUser && message.streaming === true && !message.text;
  const showCaret = !isUser && message.streaming === true && !!message.text;

  return (
    <XStack
      width="100%"
      justifyContent={isUser ? 'flex-end' : 'flex-start'}
      paddingHorizontal={16}
      marginTop={10}
    >
      <YStack
        maxWidth="86%"
        paddingVertical={10}
        paddingHorizontal={14}
        backgroundColor={isUser ? accent : palette.surface}
        borderRadius={radius.bubble}
        borderBottomRightRadius={isUser ? 6 : radius.bubble}
        borderBottomLeftRadius={isUser ? radius.bubble : 6}
        borderWidth={isUser ? 0 : 1}
        borderColor={palette.hairline}
        style={isUser ? undefined : cardShadow}
        gap={message.citations?.length || message.confidence ? 8 : 0}
      >
        <Text
          fontSize={16}
          lineHeight={22}
          letterSpacing={-0.2}
          color={isUser ? palette.white : showPlaceholder ? palette.secondaryLabel : palette.label}
        >
          {showPlaceholder ? 'Thinking…' : message.text}
          {showCaret ? ' ▌' : ''}
        </Text>

        {/* Structured assistant metadata */}
        {!isUser && (message.confidence || message.citations?.length) ? (
          <XStack flexWrap="wrap" gap={6} alignItems="center">
            {message.confidence ? (
              <XStack
                alignItems="center"
                gap={4}
                paddingHorizontal={8}
                paddingVertical={4}
                borderRadius={radius.chip}
                backgroundColor={`${confidenceColor[message.confidence]}1A`}
              >
                <Ionicons
                  name="analytics"
                  size={12}
                  color={confidenceColor[message.confidence]}
                />
                <Text
                  fontSize={12}
                  fontWeight="600"
                  color={confidenceColor[message.confidence]}
                >
                  {message.confidence} confidence
                </Text>
              </XStack>
            ) : null}

            {message.citations?.map((c) => (
              <XStack
                key={c}
                alignItems="center"
                gap={6}
                paddingHorizontal={9}
                paddingVertical={4}
                borderRadius={radius.chip}
                backgroundColor={palette.tertiarySystemFill}
              >
                {/* Brand pill: a periwinkle dot + monospaced code, à la the reference chips. */}
                <YStack width={6} height={6} borderRadius={3} backgroundColor={palette.primary} />
                <Text
                  fontFamily="$mono"
                  fontSize={12}
                  fontWeight="500"
                  color={palette.navy100}
                  letterSpacing={-0.2}
                >
                  {c}
                </Text>
              </XStack>
            ))}
          </XStack>
        ) : null}
      </YStack>
    </XStack>
  );
}

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
import type { PatientDetail } from '../api/client';

export type Role = 'user' | 'assistant';
export type Confidence = 'High' | 'Medium' | 'Low';

export interface ChatMessage {
  id: string;
  role: Role;
  text: string;
  confidence?: Confidence;
  citations?: string[];
  /** Resolved patient record(s) — rendered as PatientCards beneath the bubble. */
  patients?: PatientDetail[];
  /** Marks the safe-fallback / system notices so they can read differently. */
  pending?: boolean;
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
          color={isUser ? palette.white : palette.label}
        >
          {message.text}
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
                gap={4}
                paddingHorizontal={8}
                paddingVertical={4}
                borderRadius={radius.chip}
                backgroundColor={palette.tertiarySystemFill}
              >
                <Ionicons name="document-text" size={11} color={palette.secondaryLabel} />
                <Text fontSize={12} fontWeight="500" color={palette.secondaryLabel}>
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

// Chat composer: a growing rounded input with a circular send button — the iMessage
// pattern. The send button adopts the active cohort accent and only enables when
// there's something to send.
import React from 'react';
import { XStack, TextArea } from 'tamagui';
import { Ionicons } from '@expo/vector-icons';
import { palette, radius } from '../theme/palette';

interface ComposerProps {
  value: string;
  onChangeText: (v: string) => void;
  onSend: () => void;
  accent: string;
  disabled?: boolean;
  placeholder?: string;
}

export function Composer({
  value,
  onChangeText,
  onSend,
  accent,
  disabled = false,
  placeholder = 'Ask about a patient…',
}: ComposerProps) {
  const canSend = value.trim().length > 0 && !disabled;

  return (
    <XStack
      alignItems="flex-end"
      gap={10}
      paddingHorizontal={16}
      paddingTop={10}
      paddingBottom={8}
      backgroundColor={palette.surface}
      borderTopWidth={1}
      borderTopColor={palette.hairline}
    >
      <TextArea
        flex={1}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={palette.tertiaryLabel}
        multiline
        numberOfLines={1}
        minHeight={40}
        height={40}
        maxHeight={120}
        paddingTop={9}
        paddingBottom={9}
        paddingHorizontal={14}
        fontSize={16}
        color={palette.label}
        borderWidth={1}
        borderColor={palette.hairline}
        backgroundColor={palette.glass}
        borderRadius={radius.bubble}
        focusStyle={{ borderColor: accent }}
        onSubmitEditing={canSend ? onSend : undefined}
      />
      <XStack
        onPress={canSend ? onSend : undefined}
        accessibilityRole="button"
        accessibilityLabel="Send"
        aria-disabled={!canSend}
        animation="quick"
        pressStyle={canSend ? { scale: 0.9 } : undefined}
        cursor={canSend ? 'pointer' : 'default'}
        width={40}
        height={40}
        borderRadius={radius.chip}
        alignItems="center"
        justifyContent="center"
        backgroundColor={canSend ? accent : palette.secondarySystemFill}
      >
        <Ionicons
          name="arrow-up"
          size={22}
          color={canSend ? palette.white : palette.tertiaryLabel}
        />
      </XStack>
    </XStack>
  );
}

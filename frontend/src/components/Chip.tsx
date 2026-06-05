// Small pill used for cohort badges, confidence levels, and citation counts.
// Tinted-fill style matches iOS controls (filled, low-contrast, rounded-full).
import React from 'react';
import { XStack, Text } from 'tamagui';
import { Ionicons } from '@expo/vector-icons';
import { palette, radius } from '../theme/palette';

interface ChipProps {
  label: string;
  /** Foreground (text + icon) color. */
  color?: string;
  /** Fill behind the chip. Defaults to a faint tint of `color`. */
  background?: string;
  icon?: keyof typeof Ionicons.glyphMap;
  size?: 'sm' | 'md';
}

export function Chip({
  label,
  color = palette.navy100,
  background = palette.tertiarySystemFill,
  icon,
  size = 'md',
}: ChipProps) {
  const sm = size === 'sm';
  return (
    <XStack
      alignItems="center"
      gap={sm ? 4 : 5}
      paddingHorizontal={sm ? 8 : 10}
      paddingVertical={sm ? 3 : 5}
      borderRadius={radius.chip}
      backgroundColor={background}
    >
      {icon ? <Ionicons name={icon} size={sm ? 11 : 13} color={color} /> : null}
      <Text
        color={color}
        fontSize={sm ? 12 : 13}
        fontWeight="600"
        letterSpacing={-0.1}
      >
        {label}
      </Text>
    </XStack>
  );
}

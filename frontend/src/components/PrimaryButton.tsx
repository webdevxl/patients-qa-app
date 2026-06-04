// iOS-style filled action button (50pt tall, 17pt semibold label, full-width).
// Color is passed in so the same control can adopt a cohort's accent on the picker
// or the system blue elsewhere. Disabled state uses the iOS quaternary fill.
import React from 'react';
import { XStack, Text } from 'tamagui';
import { Ionicons } from '@expo/vector-icons';
import { palette, radius, accentShadow } from '../theme/palette';

interface PrimaryButtonProps {
  label: string;
  onPress: () => void;
  color?: string;
  disabled?: boolean;
  loading?: boolean;
  iconAfter?: keyof typeof Ionicons.glyphMap;
}

export function PrimaryButton({
  label,
  onPress,
  color = palette.blue,
  disabled = false,
  loading = false,
  iconAfter,
}: PrimaryButtonProps) {
  const inactive = disabled || loading;
  return (
    <XStack
      accessibilityRole="button"
      aria-disabled={inactive}
      onPress={inactive ? undefined : onPress}
      animation="quick"
      pressStyle={inactive ? undefined : { scale: 0.97, opacity: 0.9 }}
      cursor={inactive ? 'default' : 'pointer'}
      height={50}
      borderRadius={radius.control}
      alignItems="center"
      justifyContent="center"
      gap={8}
      backgroundColor={inactive ? palette.secondarySystemFill : color}
      style={inactive ? undefined : accentShadow(color)}
    >
      <Text
        color={inactive ? palette.tertiaryLabel : palette.white}
        fontSize={17}
        fontWeight="600"
        letterSpacing={-0.2}
      >
        {loading ? 'Working…' : label}
      </Text>
      {iconAfter && !inactive ? (
        <Ionicons name={iconAfter} size={18} color={palette.white} />
      ) : null}
    </XStack>
  );
}

// Filled action button (50pt tall, 17pt semibold label, full-width). Color is passed in
// so the same control can adopt a cohort's accent on the picker or the brand periwinkle
// elsewhere. Pass `gradient` for the brand's two-stop periwinkle CTA fill (the reference
// "Sign & Submit" look); otherwise it renders a flat fill. Disabled uses the muted fill.
import React from 'react';
import { XStack, Text } from 'tamagui';
import { LinearGradient } from '@tamagui/linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { palette, radius, accentShadow } from '../theme/palette';

interface PrimaryButtonProps {
  label: string;
  onPress: () => void;
  color?: string;
  /** Two-stop gradient fill (overrides `color` when active/enabled). */
  gradient?: readonly [string, string];
  disabled?: boolean;
  loading?: boolean;
  iconAfter?: keyof typeof Ionicons.glyphMap;
}

export function PrimaryButton({
  label,
  onPress,
  color = palette.primary,
  gradient,
  disabled = false,
  loading = false,
  iconAfter,
}: PrimaryButtonProps) {
  const inactive = disabled || loading;
  const shadowColor = gradient ? gradient[1] : color;

  const content = (
    <>
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
    </>
  );

  // Gradient fill (when enabled). LinearGradient is itself a styled stack, so it carries
  // the pressable behavior directly. The gradient paints as an absolutely-positioned fill
  // layer (z-index 0), so the label/icon must sit in a positioned layer above it (zIndex 1)
  // — otherwise the fill covers the static text.
  if (gradient && !inactive) {
    return (
      <LinearGradient
        accessibilityRole="button"
        onPress={onPress}
        animation="quick"
        pressStyle={{ scale: 0.97, opacity: 0.9 }}
        cursor="pointer"
        colors={gradient as [string, string]}
        start={[0, 0]}
        end={[1, 1]}
        height={50}
        borderRadius={radius.control}
        alignItems="center"
        justifyContent="center"
        style={accentShadow(shadowColor)}
      >
        <XStack position="relative" zIndex={1} alignItems="center" justifyContent="center" gap={8}>
          {content}
        </XStack>
      </LinearGradient>
    );
  }

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
      {content}
    </XStack>
  );
}

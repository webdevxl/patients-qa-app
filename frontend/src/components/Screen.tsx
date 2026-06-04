// Safe-area-aware screen container. One place to get iOS insets (notch + home
// indicator) right, so individual screens don't each re-derive them. Background
// defaults to the iOS grouped background for that native "Settings app" feel.
import React from 'react';
import { YStack } from 'tamagui';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { palette } from '../theme/palette';

interface ScreenProps {
  children: React.ReactNode;
  backgroundColor?: string;
  /** Skip bottom inset when a screen manages its own footer (e.g. chat composer). */
  edges?: { top?: boolean; bottom?: boolean };
}

export function Screen({
  children,
  backgroundColor = palette.systemGroupedBackground,
  edges = { top: true, bottom: true },
}: ScreenProps) {
  const insets = useSafeAreaInsets();
  return (
    <YStack
      flex={1}
      backgroundColor={backgroundColor}
      paddingTop={edges.top ? insets.top : 0}
      paddingBottom={edges.bottom ? insets.bottom : 0}
    >
      {children}
    </YStack>
  );
}

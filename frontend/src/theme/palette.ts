// iOS Human Interface Guidelines palette (light appearance).
//
// Values are Apple's published system colors so the app reads as a native iOS app
// rather than a generic web UI. Semantic labels use Apple's exact alpha values
// (e.g. secondaryLabel = 60% of #3C3C43) which is what gives iOS text its
// characteristic soft, layered hierarchy.
//
// Cohort accents are the heart of the app's identity: Group A is system blue,
// Group B is system indigo. They stay visually distinct everywhere a cohort is
// shown, reinforcing the central safety invariant (you are always inside exactly
// one cohort) at the UI layer.

export const palette = {
  // Backgrounds (grouped style — the iOS "Settings" look)
  systemGroupedBackground: '#F2F2F7',
  secondarySystemGroupedBackground: '#FFFFFF',
  surface: '#FFFFFF',

  // Labels
  label: '#1C1C1E',
  secondaryLabel: 'rgba(60,60,67,0.6)',
  tertiaryLabel: 'rgba(60,60,67,0.3)',
  quaternaryLabel: 'rgba(60,60,67,0.18)',

  // Separators / hairlines
  separator: 'rgba(60,60,67,0.29)',
  opaqueSeparator: '#C6C6C8',
  hairline: 'rgba(0,0,0,0.06)',

  // System accents
  blue: '#007AFF',
  indigo: '#5856D6',
  green: '#34C759',
  orange: '#FF9500',
  red: '#FF3B30',
  teal: '#30B0C7',

  // Pure
  white: '#FFFFFF',
  black: '#000000',

  // Fills (for chips, inactive controls)
  secondarySystemFill: 'rgba(120,120,128,0.16)',
  tertiarySystemFill: 'rgba(118,118,128,0.12)',
} as const;

export type CohortGroup = 'A' | 'B';

// Per-cohort visual identity. `tint` is a faint wash used behind a selected card so
// the whole surface, not just the badge, signals which cohort you're in.
export const cohortTheme: Record<
  CohortGroup,
  { accent: string; tint: string; onAccent: string }
> = {
  A: { accent: palette.blue, tint: 'rgba(0,122,255,0.08)', onAccent: '#FFFFFF' },
  B: { accent: palette.indigo, tint: 'rgba(88,86,214,0.08)', onAccent: '#FFFFFF' },
};

// Soft, layered iOS card shadow. Kept subtle (HIG cards use depth sparingly).
export const cardShadow = {
  shadowColor: palette.black,
  shadowOpacity: 0.06,
  shadowRadius: 18,
  shadowOffset: { width: 0, height: 8 },
  // Android elevation parity
  elevation: 3,
} as const;

// Tighter shadow for the selected/pressed state.
export const accentShadow = (color: string) =>
  ({
    shadowColor: color,
    shadowOpacity: 0.28,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    elevation: 6,
  }) as const;

// Corner radii tuned to iOS (continuous-curve cards use ~16–20).
export const radius = {
  card: 20,
  control: 14,
  chip: 999,
  bubble: 22,
} as const;

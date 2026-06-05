// CareBrain brand palette (light appearance).
//
// Re-skinned from carebrain.com: a lavender/periwinkle system on a navy-ink text
// scale. The values come straight from the site's CSS custom properties so the app
// reads as the same product. The *semantic key names* are preserved from the prior
// iOS-HIG palette (label, surface, hairline, secondarySystemFill, …) so components
// keep importing the same tokens — only the values changed.
//
// Cohort accents stay two visually distinct colors (the central safety cue — you are
// always inside exactly one cohort): Group A is brand periwinkle, Group B is a deeper
// indigo. They remain legible everywhere a cohort is shown.

export const palette = {
  // Backgrounds
  systemGroupedBackground: '#E9E7FF', // lavender app ground (brand --background)
  secondarySystemGroupedBackground: '#FFFFFF',
  surface: '#FFFFFF', // white/glass cards sit on the lavender ground

  // Brand surfaces
  glass: '#F5F4FF', // periwinkle-50 — faint glass fill
  lavender: '#ECEAFF', // periwinkle-100

  // Labels (navy ink at layered alpha steps)
  label: '#14183A', // brand --foreground (navy ink)
  secondaryLabel: 'rgba(20,24,58,0.55)',
  tertiaryLabel: 'rgba(20,24,58,0.35)',
  quaternaryLabel: 'rgba(20,24,58,0.18)',

  // Separators / hairlines (brand border #AAA5FF)
  separator: 'rgba(170,165,255,0.45)',
  opaqueSeparator: '#C9C6FF',
  hairline: 'rgba(170,165,255,0.35)',

  // Accents
  primary: '#8F8CFF', // periwinkle-600 — brand --primary
  accent: '#B7B3FF', // periwinkle-400 — brand --accent
  indigo: '#4F46E5', // deep indigo (cohort B)
  green: '#34C759', // confidence High (status — kept)
  orange: '#FF9500', // confidence Medium (status — kept)
  red: '#E06070', // brand --destructive (confidence Low / errors)
  teal: '#30B0C7',

  // Periwinkle scale (brand)
  periwinkle50: '#F5F4FF',
  periwinkle100: '#ECEAFF',
  periwinkle200: '#DFDCFF',
  periwinkle300: '#C9C6FF',
  periwinkle400: '#B7B3FF',
  periwinkle500: '#9F9CFF',
  periwinkle600: '#8F8CFF',

  // Navy scale (brand)
  navyInk: '#14183A',
  navy100: '#2A2F5C',
  navy200: '#1B1F4B',

  // Pure
  white: '#FFFFFF',
  black: '#000000',

  // Fills (chips, inactive controls) — periwinkle-tinted
  secondarySystemFill: 'rgba(143,140,255,0.16)',
  tertiarySystemFill: '#ECEAFF',
} as const;

export type CohortGroup = 'A' | 'B';

// Per-cohort visual identity. `tint` is a faint wash behind a selected/active surface;
// `gradient` is the 2-stop fill used on the cohort's primary CTA + send button.
export const cohortTheme: Record<
  CohortGroup,
  { accent: string; tint: string; gradient: [string, string]; onAccent: string }
> = {
  A: {
    accent: palette.primary, // #8F8CFF periwinkle
    tint: 'rgba(143,140,255,0.10)',
    gradient: ['#9F9CFF', '#8F8CFF'],
    onAccent: '#FFFFFF',
  },
  B: {
    accent: palette.indigo, // #4F46E5 deep indigo
    tint: 'rgba(79,70,229,0.10)',
    gradient: ['#6366F1', '#4F46E5'],
    onAccent: '#FFFFFF',
  },
};

// Default CTA gradient (periwinkle) for non-cohort primary buttons.
export const brandGradient: [string, string] = ['#9F9CFF', '#8F8CFF'];

// Soft, brand-tinted card shadow (navy ink rather than pure black for a warmer depth).
export const cardShadow = {
  shadowColor: '#14183A',
  shadowOpacity: 0.08,
  shadowRadius: 18,
  shadowOffset: { width: 0, height: 8 },
  // Android elevation parity
  elevation: 3,
} as const;

// Tighter, colored shadow for the selected/pressed state.
export const accentShadow = (color: string) =>
  ({
    shadowColor: color,
    shadowOpacity: 0.28,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    elevation: 6,
  }) as const;

// Corner radii (continuous-curve cards ~20; chat bubbles a touch rounder).
export const radius = {
  card: 20,
  control: 14,
  chip: 999,
  bubble: 22,
} as const;

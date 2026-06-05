// Tamagui design-system config.
//
// We build on `@tamagui/config/v4` `defaultConfig` for its token set
// (space/size/radius/zIndex), media queries, shorthands, light/dark themes, and the
// RN animation driver — then override two things to make the app read as CareBrain:
//   1. the FONTS: `body`/`heading` become **Plus Jakarta Sans** (the brand face) and we
//      add a `mono` (Geist Mono) for code-like labels. Because every component renders
//      bare `<Text>` with no explicit `fontFamily`, swapping the default `body` font
//      re-skins the whole app's typography with zero per-component edits.
//   2. two strict settings (see below) so the brand hex colors in `src/theme/palette.ts`
//      are accepted and longhand props are kept.
//
// Fonts are loaded at runtime in `App.tsx` via `expo-font` `useFonts` — the map keys
// there MUST equal the registered names in the `face` maps below.
import { createTamagui, createFont, isWeb } from 'tamagui';
import { defaultConfig } from '@tamagui/config/v4';

// Web uses `family` directly (+ a sane fallback stack while the webfont loads); native
// ignores `family` for weighted text and instead swaps in the per-weight `face` entry.
const JAKARTA_WEB =
  '"PlusJakartaSans_400Regular", -apple-system, system-ui, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
const MONO_WEB =
  '"GeistMono_400Regular", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace';

// Tamagui maps a numeric weight token (4..8) -> CSS weight string; the `face` map then
// (on native) resolves that weight string -> the registered ttf name from `useFonts`.
const jakartaWeight = { 4: '400', 5: '500', 6: '600', 7: '700', 8: '800' } as const;
const jakartaFace = {
  '400': { normal: 'PlusJakartaSans_400Regular' },
  '500': { normal: 'PlusJakartaSans_500Medium' },
  '600': { normal: 'PlusJakartaSans_600SemiBold' },
  '700': { normal: 'PlusJakartaSans_700Bold' },
  '800': { normal: 'PlusJakartaSans_800ExtraBold' },
} as const;

// Brand body font. Spread `defaultConfig.fonts.body` to keep its size + lineHeight scales
// untouched (existing numeric `fontSize` props keep behaving) — only family/weight/face change.
const jakartaBody = createFont({
  ...defaultConfig.fonts.body,
  family: isWeb ? JAKARTA_WEB : 'PlusJakartaSans_400Regular',
  weight: jakartaWeight,
  face: jakartaFace,
});

const jakartaHeading = createFont({
  ...defaultConfig.fonts.heading,
  family: isWeb ? JAKARTA_WEB : 'PlusJakartaSans_400Regular',
  weight: jakartaWeight,
  face: jakartaFace,
});

// Mono — opt-in via `fontFamily="$mono"` (used for ICD / citation / code-like labels).
const geistMono = createFont({
  ...defaultConfig.fonts.body,
  family: isWeb ? MONO_WEB : 'GeistMono_400Regular',
  weight: { 4: '400', 5: '500', 6: '600' },
  face: {
    '400': { normal: 'GeistMono_400Regular' },
    '500': { normal: 'GeistMono_500Medium' },
    '600': { normal: 'GeistMono_600SemiBold' },
  },
});

// `defaultConfig` ships two strict, type-level switches we relax on purpose:
//   - `onlyAllowShorthands: true` would delete longhand props (forcing `bg`/`ai`/`br`)
//     — we keep longhands for readability.
//   - `allowedStyleValues: 'somewhat-strict-web'` would reject raw hex — set `false` so
//     the exact brand colors in `src/theme/palette.ts` are accepted.
export const config = createTamagui({
  ...defaultConfig,
  fonts: {
    ...defaultConfig.fonts,
    body: jakartaBody,
    heading: jakartaHeading,
    mono: geistMono,
  },
  settings: {
    ...defaultConfig.settings,
    onlyAllowShorthands: false,
    allowedStyleValues: false,
  },
});

export default config;

export type AppConfig = typeof config;

// Make every `$token` strongly typed across the app.
declare module 'tamagui' {
  // eslint-disable-next-line @typescript-eslint/no-empty-interface
  interface TamaguiCustomConfig extends AppConfig {}
}

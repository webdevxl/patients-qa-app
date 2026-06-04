// Tamagui design-system config.
//
// We build on `@tamagui/config/v4` `defaultConfig` because it already ships:
//   - the iOS-correct system font stack (`-apple-system` => San Francisco on Apple
//     devices), so there is NO `expo-font` step and text matches Apple HIG natively,
//   - a full token set (space/size/radius/zIndex), media queries, and shorthands,
//   - light/dark themes + an RN animation driver (no extra native module needed,
//     so it stays safe on web + the new architecture).
//
// App-specific iOS colors live in `src/theme/palette.ts` and are applied explicitly
// on our primitives — that keeps the cohort accents (blue = A, indigo = B) exact
// rather than at the mercy of a generated theme ramp.
import { createTamagui } from 'tamagui';
import { defaultConfig } from '@tamagui/config/v4';

// `defaultConfig` ships two strict, type-level switches we relax on purpose:
//   - `onlyAllowShorthands: true` would delete longhand props (forcing `bg`/`ai`/`br`
//     over `backgroundColor`/`alignItems`/`borderRadius`) — we keep longhands for
//     readability.
//   - `allowedStyleValues: 'somewhat-strict-web'` would reject raw hex — we set it
//     `false` so the exact iOS HIG colors in `src/theme/palette.ts` are accepted.
export const config = createTamagui({
  ...defaultConfig,
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

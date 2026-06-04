module.exports = function (api) {
  api.cache(true);
  return {
    // Tamagui runs purely at runtime here — no `@tamagui/babel-plugin`. The plugin
    // is only an optional production optimization (static CSS extraction) and, in
    // this Expo setup, its config loader chokes on the TS `tamagui.config.ts`. Runtime
    // mode is fully supported and applies our real config (imported in `App.tsx`),
    // so themes, tokens, and the relaxed style-prop settings all work as written.
    presets: ['babel-preset-expo'],
  };
};

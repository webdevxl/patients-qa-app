// App entry. Composition root: Tamagui design system -> safe-area context -> session
// state -> the two-screen flow (cohort selection, then cohort-scoped chat).
//
// Navigation is intentionally a single piece of session state rather than a router:
// the product is exactly two steps, and gating the chat behind "is a cohort selected"
// keeps the central safety rule structural — there is simply no chat screen to reach
// without an active cohort.
import { StatusBar } from 'expo-status-bar';
import { View } from 'react-native';
import { TamaguiProvider } from 'tamagui';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useFonts } from 'expo-font';
import { PlusJakartaSans_400Regular } from '@expo-google-fonts/plus-jakarta-sans/400Regular';
import { PlusJakartaSans_500Medium } from '@expo-google-fonts/plus-jakarta-sans/500Medium';
import { PlusJakartaSans_600SemiBold } from '@expo-google-fonts/plus-jakarta-sans/600SemiBold';
import { PlusJakartaSans_700Bold } from '@expo-google-fonts/plus-jakarta-sans/700Bold';
import { PlusJakartaSans_800ExtraBold } from '@expo-google-fonts/plus-jakarta-sans/800ExtraBold';
import { GeistMono_400Regular } from '@expo-google-fonts/geist-mono/400Regular';
import { GeistMono_500Medium } from '@expo-google-fonts/geist-mono/500Medium';
import { GeistMono_600SemiBold } from '@expo-google-fonts/geist-mono/600SemiBold';
import config from './tamagui.config';
import { palette } from './src/theme/palette';
import { SessionProvider, useSession } from './src/state/SessionProvider';
import { CohortSelectScreen } from './src/screens/CohortSelectScreen';
import { ChatScreen } from './src/screens/ChatScreen';
import { postSelectGroup } from './src/api/client';

function Root() {
  const { session, selectCohort, clearCohort } = useSession();

  if (!session) {
    // Exchange the chosen cohort for a session token, then enter the chat. Errors propagate to
    // CohortSelectScreen, which surfaces them and re-enables the button for a retry.
    return (
      <CohortSelectScreen
        onSelect={async (group) => {
          const { token } = await postSelectGroup(group);
          selectCohort(group, token);
        }}
      />
    );
  }
  return (
    <ChatScreen
      group={session.group}
      token={session.token}
      onSwitchCohort={clearCohort}
    />
  );
}

export default function App() {
  // Brand fonts (Plus Jakarta Sans + Geist Mono). The map keys ARE the runtime-registered
  // family names — they must match the `face` maps in tamagui.config.ts exactly.
  const [fontsLoaded] = useFonts({
    PlusJakartaSans_400Regular,
    PlusJakartaSans_500Medium,
    PlusJakartaSans_600SemiBold,
    PlusJakartaSans_700Bold,
    PlusJakartaSans_800ExtraBold,
    GeistMono_400Regular,
    GeistMono_500Medium,
    GeistMono_600SemiBold,
  });

  // Hold on a lavender ground (not a white flash) until the brand face is ready.
  if (!fontsLoaded) {
    return (
      <View style={{ flex: 1, backgroundColor: palette.systemGroupedBackground }} />
    );
  }

  return (
    <TamaguiProvider config={config} defaultTheme="light">
      <SafeAreaProvider>
        <SessionProvider>
          <StatusBar style="dark" />
          <Root />
        </SessionProvider>
      </SafeAreaProvider>
    </TamaguiProvider>
  );
}

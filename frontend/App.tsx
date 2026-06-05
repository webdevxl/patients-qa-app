// App entry. Composition root: Tamagui design system -> safe-area context -> session
// state -> the two-screen flow (cohort selection, then cohort-scoped chat).
//
// Navigation is intentionally a single piece of session state rather than a router:
// the product is exactly two steps, and gating the chat behind "is a cohort selected"
// keeps the central safety rule structural — there is simply no chat screen to reach
// without an active cohort.
import { StatusBar } from 'expo-status-bar';
import { TamaguiProvider } from 'tamagui';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import config from './tamagui.config';
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

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

function Root() {
  const { session, selectCohort, clearCohort } = useSession();

  if (!session) {
    return <CohortSelectScreen onSelect={(group) => selectCohort(group)} />;
  }
  return <ChatScreen group={session.group} onSwitchCohort={clearCohort} />;
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

import { StatusBar } from 'expo-status-bar';
import { StyleSheet, Text, View } from 'react-native';

export default function App() {
  return (
    <View style={styles.container}>
      <StatusBar style="light" />
      <Text style={styles.title}>Patient Q&A</Text>
      <Text style={styles.subtitle}>AI Assistant — scaffold</Text>
      <Text style={styles.note}>
        Cohort selection and the chat interface come later. This blank screen
        confirms the Expo app builds and runs.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f172a',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  title: {
    color: '#f8fafc',
    fontSize: 32,
    fontWeight: '700',
  },
  subtitle: {
    color: '#94a3b8',
    fontSize: 16,
    marginTop: 8,
  },
  note: {
    color: '#64748b',
    fontSize: 14,
    textAlign: 'center',
    marginTop: 24,
    maxWidth: 320,
    lineHeight: 20,
  },
});

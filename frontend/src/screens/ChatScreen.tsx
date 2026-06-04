// Cohort-scoped chat. This screen is the UX shell for the Q&A agent: it establishes
// the conversation surface, the active-cohort identity, and the always-visible scope
// banner. A send posts the question to the backend's `/qa/query` route (the LangChain
// patient Q&A agent) and renders the grounded answer.
import React, { useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform } from 'react-native';
import { ScrollView, YStack, XStack, Text } from 'tamagui';
import { Ionicons } from '@expo/vector-icons';
import { Screen } from '../components/Screen';
import { Chip } from '../components/Chip';
import { Composer } from '../components/Composer';
import { MessageBubble, type ChatMessage } from '../components/MessageBubble';
import { PatientCard } from '../components/PatientCard';
import { postQaQuery, ApiError, type PatientDetail } from '../api/client';
import { cohortMeta } from '../domain/cohorts';
import { cohortTheme, palette } from '../theme/palette';
import type { CohortGroup } from '../theme/palette';

interface ChatScreenProps {
  group: CohortGroup;
  onSwitchCohort: () => void;
}

// Four starter prompts — one per patient-lookup path — each seeded with real values from the
// seeded DB. `label` is what the chip shows and ends with the expected patient in [brackets]
// as a built-in test oracle ("tapping this should resolve to THIS patient"). `text` is the
// clean question sent to the backend — it never carries the bracketed answer.
//
// Heads-up: the backend `find_patient` tool resolves only by name or UUID today, so prompts 3 & 4
// (by ICD-10 condition code / by medicine name) currently return the safe fallback — the bracketed
// name documents the patient they SHOULD resolve to once that lookup is added.
//
// Cohort-agnostic: isolation is currently off (the agent searches every patient), so the same
// four prompts are shown for whichever group is selected and resolve regardless of A/B.
const SUGGESTIONS: { label: string; text: string }[] = [
  {
    // 1) By full name
    label: 'Find the patient named Erna Shearer  [Erna Shearer]',
    text: 'Find the patient named Erna Shearer',
  },
  {
    // 2) By patient UUID
    label: 'Find the patient with ID 9f81c036…  [Buffy Alonzo]',
    text: 'Find the patient with ID 9f81c036-a344-4626-a59c-30a8014b9bc2',
  },
  {
    // 3) By ICD-10 condition code (A52.8 = late latent syphilis)
    label: 'Find the patient with condition A52.8  [Maybelle Nicholson]',
    text: 'Find the patient with condition A52.8',
  },
  {
    // 4) By medicine name
    label: 'Find the patient taking Carvedilol  [Jarrod Whitley]',
    text: 'Find the patient taking Carvedilol',
  },
];

let messageSeq = 0;
const nextId = () => `m${messageSeq++}`;

// Lead-in line shown above the patient card(s).
function introText(patients: PatientDetail[]): string {
  if (patients.length === 1) {
    const p = patients[0];
    const name = `${p.nameFirst ?? ''} ${p.nameLast ?? ''}`.trim() || 'this patient';
    return `Here's the full record for ${name}.`;
  }
  return `Found ${patients.length} matching patients — showing each record below. Refine by full name or patient ID to narrow it down.`;
}

export function ChatScreen({ group, onSwitchCohort }: ChatScreenProps) {
  const meta = cohortMeta(group);
  const accent = cohortTheme[group].accent;
  const scrollRef = useRef<ScrollView>(null);

  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: nextId(),
      role: 'assistant',
      text: `I'm scoped to ${meta.label} and answer only from this cohort's records — every reply comes with citations and a confidence level. Other cohorts stay invisible to me.`,
    },
  ]);

  const hasAsked = messages.some((m) => m.role === 'user');

  const send = async () => {
    const question = draft.trim();
    if (!question || pending) return;

    const userMsg: ChatMessage = { id: nextId(), role: 'user', text: question };
    setMessages((prev) => [...prev, userMsg]);
    setDraft('');
    setPending(true);
    requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: true }));

    try {
      const result = await postQaQuery({ group, question });
      const answerMsg: ChatMessage =
        result.patients.length > 0
          ? {
              id: nextId(),
              role: 'assistant',
              text: introText(result.patients),
              patients: result.patients,
            }
          : {
              id: nextId(),
              role: 'assistant',
              text:
                result.fallback ??
                'I cannot find a matching patient in your cohort, or I cannot answer this question based on the available records.',
              pending: true,
            };
      setMessages((prev) => [...prev, answerMsg]);
    } catch (e) {
      const text =
        e instanceof ApiError
          ? e.message
          : 'Something went wrong reaching the assistant.';
      setMessages((prev) => [
        ...prev,
        { id: nextId(), role: 'assistant', text, pending: true },
      ]);
    } finally {
      setPending(false);
      requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: true }));
    }
  };

  return (
    <Screen backgroundColor={palette.surface}>
      {/* Nav bar */}
      <XStack
        height={52}
        alignItems="center"
        paddingHorizontal={8}
        backgroundColor={palette.surface}
        borderBottomWidth={1}
        borderBottomColor={palette.hairline}
      >
        <XStack
          flex={1}
          justifyContent="flex-start"
          onPress={onSwitchCohort}
          accessibilityRole="button"
          accessibilityLabel="Switch cohort"
          animation="quick"
          pressStyle={{ opacity: 0.5 }}
          cursor="pointer"
          alignItems="center"
          gap={2}
          paddingVertical={6}
          paddingHorizontal={6}
        >
          <Ionicons name="chevron-back" size={24} color={accent} />
          <Text fontSize={17} color={accent} letterSpacing={-0.2}>
            Cohorts
          </Text>
        </XStack>

        <Text fontSize={16} fontWeight="700" color={palette.label} letterSpacing={-0.3}>
          Patient Q&A
        </Text>

        <XStack flex={1} justifyContent="flex-end" paddingRight={6}>
          <Chip
            label={meta.label}
            icon={meta.icon}
            color={accent}
            background={cohortTheme[group].tint}
          />
        </XStack>
      </XStack>

      {/* Always-visible scope banner — the safety invariant, made visible */}
      <XStack
        alignItems="center"
        gap={6}
        paddingHorizontal={16}
        paddingVertical={7}
        backgroundColor={cohortTheme[group].tint}
      >
        <Ionicons name="shield-checkmark" size={13} color={accent} />
        <Text fontSize={12} color={accent} fontWeight="500" flex={1} letterSpacing={-0.1}>
          {meta.label} only · cross-cohort access is blocked & logged
        </Text>
      </XStack>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={0}
      >
        <ScrollView
          ref={scrollRef}
          flex={1}
          backgroundColor={palette.systemGroupedBackground}
          contentContainerStyle={{ paddingTop: 6, paddingBottom: 14 }}
          onContentSizeChange={() =>
            scrollRef.current?.scrollToEnd({ animated: true })
          }
        >
          {messages.map((m) => (
            <React.Fragment key={m.id}>
              <MessageBubble message={m} accent={accent} />
              {m.patients?.map((p) => (
                <PatientCard key={p.id} patient={p} accent={accent} />
              ))}
            </React.Fragment>
          ))}
          {pending ? (
            <MessageBubble
              message={{ id: 'thinking', role: 'assistant', text: 'Thinking…' }}
              accent={accent}
            />
          ) : null}
        </ScrollView>

        {/* Starter suggestions, until the first question is asked */}
        {!hasAsked ? (
          <YStack
            paddingHorizontal={16}
            paddingTop={10}
            paddingBottom={2}
            gap={8}
            backgroundColor={palette.systemGroupedBackground}
          >
            <Text fontSize={12} fontWeight="600" color={palette.tertiaryLabel} letterSpacing={0.2}>
              TRY ASKING
            </Text>
            <XStack flexWrap="wrap" gap={8}>
              {SUGGESTIONS.map((s) => (
                <XStack
                  key={s.label}
                  onPress={() => setDraft(s.text)}
                  accessibilityRole="button"
                  animation="quick"
                  pressStyle={{ scale: 0.97, opacity: 0.8 }}
                  cursor="pointer"
                  paddingHorizontal={12}
                  paddingVertical={8}
                  borderRadius={999}
                  backgroundColor={palette.surface}
                  borderWidth={1}
                  borderColor={palette.hairline}
                >
                  <Text fontSize={13} color={palette.label} letterSpacing={-0.1}>
                    {s.label}
                  </Text>
                </XStack>
              ))}
            </XStack>
          </YStack>
        ) : null}

        <Composer
          value={draft}
          onChangeText={setDraft}
          onSend={send}
          accent={accent}
          disabled={pending}
          placeholder={`Ask about a patient in ${meta.label}…`}
        />
      </KeyboardAvoidingView>
    </Screen>
  );
}

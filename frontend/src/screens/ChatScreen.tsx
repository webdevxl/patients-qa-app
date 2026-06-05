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
import { ConditionMatchCard } from '../components/ConditionMatchCard';
import { PatientDetailModal } from '../components/PatientDetailModal';
import {
  postQaQuery,
  ApiError,
  type PatientDetail,
  type ConditionMatch,
  type ChatTurn,
} from '../api/client';
import { cohortMeta } from '../domain/cohorts';
import { cohortTheme, palette } from '../theme/palette';
import type { CohortGroup } from '../theme/palette';

interface ChatScreenProps {
  group: CohortGroup;
  /** Session token from group selection; sent as Basic auth on every query. */
  token: string;
  onSwitchCohort: () => void;
}

// Starter prompts — each seeded with real values from the seeded DB. `label` is what the chip
// shows and ends with a built-in test oracle in [brackets] (the patient it should resolve to,
// or — for the multi-result allergy searches — how many patients match). `text` is the clean
// question sent to the backend — it never carries the bracketed answer.
//
// Heads-up: the backend `find_patient` tool resolves only by name or UUID today, so prompts 3 & 4
// (by ICD-10 condition code / by medicine name) currently return the safe fallback — the bracketed
// name documents the patient they SHOULD resolve to once that lookup is added.
//
// Prompts 5–7 exercise the semantic ALLERGY search (find_patients_by_condition's allergyQuery
// arg): the allergen is embedded and cosine-matched against the canonical allergen vocabulary,
// returning the top-matching patients (capped at 5). Counts below are total patients with that
// allergen in the data.
//
// Cohort isolation is now enforced: every query is scoped to the selected group, so these static
// starter prompts resolve only when the referenced patient/allergen lives in the active cohort —
// the same chip can return a real record in one group and the safe fallback in the other. (A
// per-cohort suggestion set is a follow-up; left static here so the chips also demonstrate the
// boundary.)
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
  {
    // 5) By allergy — semantic allergen search
    label: 'Find patients allergic to penicillin  [top 5 of 13]',
    text: 'Find patients allergic to penicillin',
  },
  {
    // 6) By allergy — semantic allergen search
    label: 'Find patients allergic to sulfa antibiotics  [top 5 of 10]',
    text: 'Find patients allergic to sulfa antibiotics',
  },
  {
    // 7) By allergy — semantic allergen search
    label: 'Find patients allergic to codeine  [8 patients]',
    text: 'Find patients allergic to codeine',
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

// Lead-in line shown above the semantic-search match cards. The same tool serves condition,
// allergy and measurement queries (in any combination), so the wording adapts to what matched.
function conditionIntro(matches: ConditionMatch[]): string {
  const n = matches.length;
  const dims: string[] = [];
  if (matches.some((m) => m.matchedCondition)) dims.push('diagnosis');
  if (matches.some((m) => m.matchedAllergy)) dims.push('allergy');
  if (matches.some((m) => m.matchedObservation)) dims.push('measurement');
  const what =
    dims.length === 0
      ? 'record'
      : dims.length <= 2
        ? dims.join(' and ')
        : `${dims.slice(0, -1).join(', ')} and ${dims[dims.length - 1]}`;
  return `Found ${n} patient${n === 1 ? '' : 's'} with a matching ${what} — each shown below. Ask about one by name for the full record.`;
}

export function ChatScreen({ group, token, onSwitchCohort }: ChatScreenProps) {
  const meta = cohortMeta(group);
  const accent = cohortTheme[group].accent;
  const scrollRef = useRef<ScrollView>(null);

  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState(false);
  // The condition-match patient expanded in the detail modal (null = closed). The full record
  // is already in hand from the search response, so tapping opens it with no extra request.
  const [openPatient, setOpenPatient] = useState<PatientDetail | null>(null);
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

    // Build conversation history from the transcript SO FAR (this closure's `messages` predates
    // the question we're sending). User turns carry their text; assistant turns carry only the
    // compact `contextSummary` from a real answer (skipping the greeting / errors / fallbacks),
    // so the backend extractor can resolve "his/her" without ever seeing full records.
    const history: ChatTurn[] = messages
      .map((m): ChatTurn | null =>
        m.role === 'user'
          ? { role: 'user', content: m.text }
          : m.contextSummary
            ? { role: 'assistant', content: m.contextSummary }
            : null,
      )
      .filter((t): t is ChatTurn => t !== null)
      .slice(-8);

    try {
      const result = await postQaQuery(token, { question, history });
      // The backend routes to one retrieval: `patients` (full record) or `matches`
      // (condition/allergy search). Either array may be absent, so guard before reading length.
      let answerMsg: ChatMessage;
      if (result.patients && result.patients.length > 0) {
        answerMsg = {
          id: nextId(),
          role: 'assistant',
          text: introText(result.patients),
          patients: result.patients,
          contextSummary: result.contextSummary,
        };
      } else if (result.matches && result.matches.length > 0) {
        answerMsg = {
          id: nextId(),
          role: 'assistant',
          text: conditionIntro(result.matches),
          matches: result.matches,
          contextSummary: result.contextSummary,
        };
      } else {
        answerMsg = {
          id: nextId(),
          role: 'assistant',
          text:
            result.fallback ??
            'I cannot find a matching patient in your cohort, or I cannot answer this question based on the available records.',
          pending: true,
        };
      }
      setMessages((prev) => [...prev, answerMsg]);
    } catch (e) {
      // A 401 means the session token is missing/expired/invalid — drop back to the picker so a
      // fresh one is minted, rather than leaving the user stuck on a screen that can't answer.
      if (e instanceof ApiError && e.status === 401) {
        onSwitchCohort();
        return;
      }
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
              {m.matches?.map((mm) => (
                <ConditionMatchCard
                  key={mm.patient.id}
                  match={mm}
                  accent={accent}
                  onPress={() => setOpenPatient(mm.patient)}
                />
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

      {/* Tapping a condition-match card expands the full record (already loaded) here. */}
      <PatientDetailModal
        patient={openPatient}
        accent={accent}
        onClose={() => setOpenPatient(null)}
      />
    </Screen>
  );
}

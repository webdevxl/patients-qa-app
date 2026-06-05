// Cohort-scoped chat — a guided three-phase flow:
//
//   1. FIND     — the user asks search-style questions; the backend returns candidate patients.
//   2. SELECT   — one match auto-proceeds; many matches hide the composer and show a clickable
//                 list ("which patient?"). Tapping a row PINS that patient by id.
//   3. ASK      — with a patient active, the composer is scoped to them: every follow-up sends
//                 `patientId` and the backend answers ONLY from that patient's records, with a
//                 confidence level and citations.
//
// History lives here in React state and the whole transcript is sent on each request (the backend
// is stateless and sanitizes/caps it). The active cohort is carried by the session token, never the
// body — the backend re-verifies any `patientId` against that cohort, so the chat can't leak across
// groups.
import React, { useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform } from 'react-native';
import { ScrollView, YStack, XStack, Text } from 'tamagui';
import { Ionicons } from '@expo/vector-icons';
import { Screen } from '../components/Screen';
import { Chip } from '../components/Chip';
import { Composer } from '../components/Composer';
import { MessageBubble, type ChatMessage } from '../components/MessageBubble';
import { PatientCard } from '../components/PatientCard';
import { CandidateRow, type CandidateItem } from '../components/CandidateRow';
import {
  postQaQuery,
  ApiError,
  type PatientDetail,
  type ChatTurn,
} from '../api/client';
import { cohortMeta } from '../domain/cohorts';
import { cohortTheme, palette, radius } from '../theme/palette';
import type { CohortGroup } from '../theme/palette';

interface ChatScreenProps {
  group: CohortGroup;
  /** Session token from group selection; sent as Basic auth on every query. */
  token: string;
  onSwitchCohort: () => void;
}

/** The guided-flow phase. `choosing` hides the composer and shows only the candidate list. */
type Mode = 'search' | 'choosing' | 'patient';

const SAFE_FALLBACK =
  'I cannot find a matching patient in your cohort, or I cannot answer this question based on the available records.';

// Starter prompts for the FIND phase — each seeded with real values from the seeded DB. `text` is
// the clean question sent to the backend; the bracketed note in `label` documents what it resolves
// to. Cohort isolation applies, so a prompt only resolves when that patient/allergen is in the
// active group.
const SUGGESTIONS: { label: string; text: string }[] = [
  { label: 'Find the patient named Erna Shearer  [Erna Shearer]', text: 'Find the patient named Erna Shearer' },
  {
    label: 'Find the patient with ID 9f81c036…  [Buffy Alonzo]',
    text: 'Find the patient with ID 9f81c036-a344-4626-a59c-30a8014b9bc2',
  },
  { label: 'Find the patient with condition A52.8  [Maybelle Nicholson]', text: 'Find the patient with condition A52.8' },
  { label: 'Find the patient taking Carvedilol  [Jarrod Whitley]', text: 'Find the patient taking Carvedilol' },
  { label: 'Find patients allergic to penicillin  [top 5 of 13]', text: 'Find patients allergic to penicillin' },
  { label: 'Find patients allergic to sulfa antibiotics  [top 5 of 10]', text: 'Find patients allergic to sulfa antibiotics' },
  { label: 'Find patients allergic to codeine  [8 patients]', text: 'Find patients allergic to codeine' },
];

let messageSeq = 0;
const nextId = () => `m${messageSeq++}`;

function fullName(p: PatientDetail): string {
  return `${p.nameFirst ?? ''} ${p.nameLast ?? ''}`.trim() || 'this patient';
}

/** Whole years between `dob` (YYYY-MM-DD) and today — parsed by parts to avoid TZ drift. */
function age(dob: string | null): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dob ?? '');
  if (!m) return null;
  const [, y, mo, d] = m.map(Number);
  const now = new Date();
  let years = now.getFullYear() - y;
  const monthDiff = now.getMonth() + 1 - mo;
  if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < d)) years -= 1;
  return years;
}

/** First N non-empty items, "a, b, c (+K more)". */
function topList(items: (string | null | undefined)[], n: number): string {
  const clean = items.filter((x): x is string => !!x && x.trim().length > 0);
  if (!clean.length) return '';
  const shown = clean.slice(0, n).join(', ');
  const extra = clean.length - n;
  return extra > 0 ? `${shown} (+${extra} more)` : shown;
}

/**
 * The templated brief shown the moment a patient is selected — built entirely from the record the
 * backend already returned, so it's instant and grounded by construction (it can't say anything not
 * in the data). Free-text follow-ups go to the model; this overview does not.
 */
function buildPatientBrief(p: PatientDetail): string {
  const yrs = age(p.dob);
  const demo = [yrs != null ? `${yrs}-year-old` : null, p.gender].filter(Boolean).join(' ');
  const conds = topList(p.conditions.map((c) => c.icd10Description ?? c.icd10Code), 3);
  const meds = topList(p.medications.map((m) => m.description ?? m.genericName), 3);
  const allergies = topList(p.allergies.map((a) => a.allergen), 3);
  return (
    `Here's ${fullName(p)}${demo ? `, ${demo}` : ''}. ` +
    `Conditions: ${conds || 'none on record'}. ` +
    `Current medications: ${meds || 'none on record'}. ` +
    `Allergies: ${allergies || 'none on record'}. ` +
    `Ask me anything about this patient's records.`
  );
}

export function ChatScreen({ group, token, onSwitchCohort }: ChatScreenProps) {
  const meta = cohortMeta(group);
  const accent = cohortTheme[group].accent;
  const scrollRef = useRef<ScrollView>(null);

  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState(false);
  const [mode, setMode] = useState<Mode>('search');
  const [activePatient, setActivePatient] = useState<PatientDetail | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: nextId(),
      role: 'assistant',
      text: `I'm scoped to ${meta.label}. First find a patient — by name, ID, condition, allergy, medication, or a measurement — then pick one and ask anything about their records. Other cohorts stay invisible to me.`,
    },
  ]);

  const hasAsked = messages.some((m) => m.role === 'user');

  const scrollToEnd = () =>
    requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: true }));

  const append = (msg: ChatMessage) => setMessages((prev) => [...prev, msg]);

  /**
   * Conversation history sent on every request (whole transcript, no slice). User turns carry their
   * text; assistant turns carry their compact `contextSummary` (a resolution summary, an answer, or
   * a selection note) — the greeting / errors / fallbacks have none and are skipped. The backend
   * sanitizes and caps it (last 6 turns × 500 chars).
   */
  const buildHistory = (): ChatTurn[] =>
    messages
      .map((m): ChatTurn | null =>
        m.role === 'user'
          ? { role: 'user', content: m.text }
          : m.contextSummary
            ? { role: 'assistant', content: m.contextSummary }
            : null,
      )
      .filter((t): t is ChatTurn => t !== null);

  /** Pin a patient and enter the ASK phase: templated brief + full record card, no backend call. */
  const selectPatient = (patient: PatientDetail) => {
    setActivePatient(patient);
    setMode('patient');
    append({
      id: nextId(),
      role: 'assistant',
      text: buildPatientBrief(patient),
      patients: [patient],
      // Goes into history so the answerer has context for "what about his allergies?" follow-ups.
      contextSummary: `Now answering about ${fullName(patient)} (id ${patient.id}).`,
    });
    scrollToEnd();
  };

  /** Tap a candidate row: it reads as if the user sent that patient's name, then we select by id. */
  const chooseCandidate = (item: CandidateItem) => {
    append({ id: nextId(), role: 'user', text: fullName(item.patient) });
    selectPatient(item.patient);
  };

  /** Leave the ASK phase and go back to searching for a different patient. */
  const backToSearch = () => {
    setActivePatient(null);
    setMode('search');
    append({
      id: nextId(),
      role: 'assistant',
      text: 'Okay — search for another patient by name, ID, condition, allergy, medication, or measurement.',
    });
    scrollToEnd();
  };

  // Route a FIND response: 0 → fallback, 1 → auto-select, many → disambiguation list.
  const handleFindResult = (result: Awaited<ReturnType<typeof postQaQuery>>) => {
    const items: CandidateItem[] = result.matches
      ? result.matches.map((m) => ({ patient: m.patient, match: m }))
      : (result.patients ?? []).map((p) => ({ patient: p }));

    if (items.length === 0) {
      append({
        id: nextId(),
        role: 'assistant',
        text: result.fallback ?? SAFE_FALLBACK,
        pending: true,
      });
      return;
    }
    if (items.length === 1) {
      selectPatient(items[0].patient);
      return;
    }
    append({
      id: nextId(),
      role: 'assistant',
      text: `I found ${items.length} patients — which one do you want information for?`,
      candidates: items,
      contextSummary: `Found ${items.length} candidates: ${items
        .map((i) => fullName(i.patient))
        .join(', ')}.`,
    });
    setMode('choosing');
  };

  // Route an ASK response: grounded answer (+ confidence/citations) or the safe fallback.
  const handlePatientAnswer = (result: Awaited<ReturnType<typeof postQaQuery>>) => {
    if (result.answer) {
      append({
        id: nextId(),
        role: 'assistant',
        text: result.answer,
        confidence: result.confidence,
        citations: result.citations,
        contextSummary: result.answer,
      });
    } else {
      append({
        id: nextId(),
        role: 'assistant',
        text: result.fallback ?? SAFE_FALLBACK,
        pending: true,
      });
    }
  };

  const send = async () => {
    const question = draft.trim();
    if (!question || pending || mode === 'choosing') return;

    const inPatientMode = mode === 'patient' && !!activePatient;
    append({ id: nextId(), role: 'user', text: question });
    setDraft('');
    setPending(true);
    scrollToEnd();

    const history = buildHistory();

    try {
      const result = await postQaQuery(
        token,
        inPatientMode
          ? { question, history, patientId: activePatient!.id }
          : { question, history },
      );
      if (inPatientMode) handlePatientAnswer(result);
      else handleFindResult(result);
    } catch (e) {
      // 401 ⇒ the session token is missing/expired/invalid — drop back to the picker to re-mint.
      if (e instanceof ApiError && e.status === 401) {
        onSwitchCohort();
        return;
      }
      append({
        id: nextId(),
        role: 'assistant',
        text: e instanceof ApiError ? e.message : 'Something went wrong reaching the assistant.',
        pending: true,
      });
    } finally {
      setPending(false);
      scrollToEnd();
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

      {/* Active-patient bar — visible in the ASK phase so the scope (this one patient) is legible. */}
      {mode === 'patient' && activePatient ? (
        <XStack
          alignItems="center"
          gap={8}
          paddingHorizontal={16}
          paddingVertical={8}
          backgroundColor={palette.surface}
          borderBottomWidth={1}
          borderBottomColor={palette.hairline}
        >
          <Ionicons name="person-circle" size={18} color={accent} />
          <Text fontSize={13} fontWeight="600" color={palette.label} flex={1} numberOfLines={1}>
            {fullName(activePatient)}
            <Text fontSize={13} fontWeight="400" color={palette.secondaryLabel}>
              {'  ·  '}Group {activePatient.group}
            </Text>
          </Text>
          <XStack
            onPress={backToSearch}
            accessibilityRole="button"
            accessibilityLabel="Change patient"
            animation="quick"
            pressStyle={{ opacity: 0.6 }}
            cursor="pointer"
            alignItems="center"
            gap={4}
            paddingVertical={4}
            paddingHorizontal={8}
            borderRadius={radius.chip}
            backgroundColor={cohortTheme[group].tint}
          >
            <Ionicons name="swap-horizontal" size={14} color={accent} />
            <Text fontSize={13} fontWeight="600" color={accent}>
              Change
            </Text>
          </XStack>
        </XStack>
      ) : null}

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
          onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
        >
          {messages.map((m) => (
            <React.Fragment key={m.id}>
              <MessageBubble message={m} accent={accent} />
              {m.patients?.map((p) => (
                <PatientCard key={p.id} patient={p} accent={accent} />
              ))}
              {m.candidates?.length ? (
                <YStack>
                  {m.candidates.map((item) => (
                    <CandidateRow
                      key={item.patient.id}
                      item={item}
                      accent={accent}
                      onPress={() => chooseCandidate(item)}
                    />
                  ))}
                  {/* Escape hatch: none of these → back to searching. */}
                  <XStack
                    marginHorizontal={16}
                    marginTop={8}
                    paddingVertical={11}
                    justifyContent="center"
                    onPress={backToSearch}
                    accessibilityRole="button"
                    accessibilityLabel="None of these — search again"
                    cursor="pointer"
                    animation="quick"
                    pressStyle={{ opacity: 0.6 }}
                  >
                    <Text fontSize={13} fontWeight="600" color={accent}>
                      None of these — search again
                    </Text>
                  </XStack>
                </YStack>
              ) : null}
            </React.Fragment>
          ))}
          {pending ? (
            <MessageBubble
              message={{ id: 'thinking', role: 'assistant', text: 'Thinking…' }}
              accent={accent}
            />
          ) : null}
        </ScrollView>

        {/* Starter suggestions — only before the first question, only while searching. */}
        {mode === 'search' && !hasAsked ? (
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

        {/* Composer — hidden while choosing (the list IS the only interaction); placeholder adapts. */}
        {mode === 'choosing' ? (
          <XStack
            paddingHorizontal={16}
            paddingVertical={14}
            backgroundColor={palette.surface}
            borderTopWidth={1}
            borderTopColor={palette.hairline}
            justifyContent="center"
          >
            <Text fontSize={13} color={palette.secondaryLabel}>
              Select a patient above to continue
            </Text>
          </XStack>
        ) : (
          <Composer
            value={draft}
            onChangeText={setDraft}
            onSend={send}
            accent={accent}
            disabled={pending}
            placeholder={
              mode === 'patient' && activePatient
                ? `Ask about ${activePatient.nameFirst ?? 'this patient'}…`
                : `Find a patient in ${meta.label}…`
            }
          />
        )}
      </KeyboardAvoidingView>
    </Screen>
  );
}

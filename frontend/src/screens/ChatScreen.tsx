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
import { PatientSummaryCard } from '../components/PatientSummaryCard';
import { PinnedPatientCard } from '../components/PinnedPatientCard';
import { PatientDetailModal } from '../components/PatientDetailModal';
import { TokenUsageBar, ZERO_USAGE, type SessionUsage } from '../components/TokenUsageBar';
import {
  postQaQuery,
  streamQaQuery,
  ApiError,
  type PatientDetail,
  type ChatTurn,
  type CandidateItem,
  type RequestUsage,
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

/** The guided-flow phase. `choosing` hides the composer and shows only the candidate list. */
type Mode = 'search' | 'choosing' | 'patient';

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

/**
 * One stable conversation id per ChatScreen mount, sent on every request so the backend stamps it as
 * the LangSmith `session_id` — grouping the whole chat's per-turn traces (find + answer) into one
 * thread instead of scattered rows. Switching cohort remounts this screen, so a new conversation gets
 * a fresh id. Not security-sensitive (pure observability correlation), so a lightweight unique-enough
 * id is fine — it never needs to be unguessable.
 */
const makeSessionId = (): string =>
  `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;

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
  // Stable for this conversation; echoed on every request → groups the chat into one LangSmith thread.
  const sessionId = useRef(makeSessionId()).current;

  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState(false);
  const [mode, setMode] = useState<Mode>('search');
  // Cumulative token accounting across the session, accumulated from each response's `usage`. The
  // backend is stateless, so this running total lives here; the TokenUsageBar footer renders it.
  const [usage, setUsage] = useState<SessionUsage>(ZERO_USAGE);
  const [activePatient, setActivePatient] = useState<PatientDetail | null>(null);
  // The patient whose full record is open in the detail modal (null = closed). Independent of the
  // active (pinned) patient: you can peek any candidate's record without committing to ask about them.
  const [detailPatient, setDetailPatient] = useState<PatientDetail | null>(null);
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

  /** Merge a partial update into one message by id — used to grow/finalize the streaming bubble. */
  const patchMessage = (id: string, patch: Partial<ChatMessage>) =>
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch } : m)));

  /**
   * Fold one response's token usage into the cumulative session total — shared by the find path and
   * the streaming answer path. Responses with no `usage` (e.g. an empty question) leave totals
   * untouched and keep the prior `lastContextTokens`.
   */
  const accumulateUsage = (u: RequestUsage | undefined) => {
    if (!u) return;
    setUsage((prev) => ({
      cumulativeInput: prev.cumulativeInput + (u.inputTokens ?? 0),
      cumulativeOutput: prev.cumulativeOutput + (u.outputTokens ?? 0),
      cumulativeTotal: prev.cumulativeTotal + (u.totalTokens ?? 0),
      turns: prev.turns + 1,
      lastContextTokens: u.inputTokens ?? prev.lastContextTokens,
      contextWindow: u.contextWindow,
      model: u.model,
    }));
  };

  /**
   * Conversation history sent on every request (whole transcript, no slice). User turns carry their
   * text; assistant turns carry their compact `contextSummary` (a resolution summary, an answer, or
   * a selection note) — the greeting / errors / fallbacks have none and are skipped. The backend
   * sanitizes and caps it (last 6 turns × 500 chars).
   */
  const buildHistory = (): ChatTurn[] =>
    messages
      .map((m): ChatTurn | null => {
        // Only phase-tagged turns enter history (also narrows agentName to the required field). Every
        // emitted turn is tagged at its append site, so this never drops a real turn.
        if (!m.agentName) return null;
        if (m.role === 'user')
          return { role: 'user', content: m.text, agentName: m.agentName, patientId: m.patientId };
        return m.contextSummary
          ? {
              role: 'assistant',
              content: m.contextSummary,
              agentName: m.agentName,
              patientId: m.patientId,
            }
          : null;
      })
      .filter((t): t is ChatTurn => t !== null);

  /**
   * Pin a patient and enter the ASK phase: a templated brief, no backend call. We don't re-render the
   * full record inline — the active-patient bar (tap to open) and the result card above both lead to
   * the detail modal, so the transcript stays compact.
   */
  const selectPatient = (patient: PatientDetail) => {
    setActivePatient(patient);
    setMode('patient');
    setDetailPatient(null);
    // UI-only brief — deliberately untagged (no agentName/contextSummary) so it never enters
    // history. The answerer's patient anchor is the records block (re-sent in full on every
    // request, and they name the patient) plus the real Q&A turns; a boundary turn would only
    // duplicate that and leak the internal patient id.
    append({
      id: nextId(),
      role: 'assistant',
      text: buildPatientBrief(patient),
    });
    scrollToEnd();
  };

  /** Tap a candidate row: it reads as if the user sent that patient's name, then we select by id. */
  const chooseCandidate = (item: CandidateItem) => {
    // A patient is already pinned — ignore further picks so the chat stays scoped to that one.
    // (The card's Ask button is disabled in this state; this is just defense in depth.)
    if (activePatient) return;
    // The candidate echo is a find-phase selection action — the answerer doesn't need it (it has
    // the full records, which name the patient, re-sent on every request).
    append({ id: nextId(), role: 'user', text: fullName(item.patient), agentName: 'find-patient' });
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

  // Route a FIND response: 0 → fallback; otherwise render every hit (one or many) as the same
  // minimized card. A single hit is NOT auto-expanded — it gets the same two-action card, so the
  // clinician chooses to peek the record or start asking. Many hits hide the composer (force a pick).
  const handleFindResult = (result: Awaited<ReturnType<typeof postQaQuery>>) => {
    const items: CandidateItem[] = result.matches
      ? result.matches.map((m) => ({ patient: m.patient, match: m }))
      : (result.patients ?? []).map((p) => ({ patient: p }));

    if (items.length === 0) {
      append({
        id: nextId(),
        role: 'assistant',
        // Backend owns the fallback wording — it always sets `fallback` on a 0-match result.
        text: result.fallback ?? '',
        agentName: 'find-patient',
        // Surface the find agent's rationale even on a no-match — explains WHY the search ran the
        // way it did. Absent when the extractor refused before producing structured output.
        extractionReasoning: result.extractionReasoning,
        pending: true,
      });
      return;
    }

    const many = items.length > 1;
    append({
      id: nextId(),
      role: 'assistant',
      text: many
        ? `I found ${items.length} patients — open a record, or tap Ask to choose one.`
        : 'I found a match — view the record, or tap Ask to start asking about them.',
      candidates: items,
      agentName: 'find-patient',
      extractionReasoning: result.extractionReasoning,
      contextSummary: many
        ? `Found ${items.length} candidates: ${items.map((i) => fullName(i.patient)).join(', ')}.`
        : `Found 1 candidate: ${fullName(items[0].patient)}.`,
    });
    // Many → force a pick (composer hidden by 'choosing'). One → leave search open so the user can
    // act on the card or refine the query.
    setMode(many ? 'choosing' : 'search');
  };

  // Finalize the live streaming bubble (`liveId`) from the authoritative answer result: a grounded
  // answer (+ confidence/citations) or the safe fallback. Mirrors the old append-based handler but
  // PATCHES the bubble that was already streaming, and clears the `streaming` flag. `contextSummary`
  // is set in both branches so the turn enters `history` (a later "answer the previous question" sees
  // it). The fallback keeps `pending: true` so it reads as a system notice.
  const finalizePatientAnswer = (liveId: string, result: Awaited<ReturnType<typeof postQaQuery>>) => {
    if (result.answer) {
      patchMessage(liveId, {
        text: result.answer,
        confidence: result.confidence,
        citations: result.citations,
        // Grounded rationale — shown only behind the bubble's "Show reasoning" disclosure.
        answerReasoning: result.answerReasoning,
        contextSummary: result.answer,
        streaming: false,
      });
    } else {
      const fallback = result.fallback ?? '';
      patchMessage(liveId, {
        // Backend owns the fallback wording — it always sets `fallback` when there's no answer.
        text: fallback,
        // The not-answerable fallback DOES carry reasoning (what was missing from the record); the
        // cohort-boundary block doesn't. Absent on the wire when the answerer never ran.
        answerReasoning: result.answerReasoning,
        contextSummary: fallback,
        pending: true,
        streaming: false,
      });
    }
  };

  const send = async () => {
    const question = draft.trim();
    if (!question || pending || mode === 'choosing') return;

    const inPatientMode = mode === 'patient' && !!activePatient;
    append({
      id: nextId(),
      role: 'user',
      text: question,
      agentName: inPatientMode ? 'answer-patient' : 'find-patient',
      ...(inPatientMode ? { patientId: activePatient!.id } : {}),
    });
    setDraft('');
    setPending(true);
    scrollToEnd();

    const history = buildHistory();

    // Holds the streaming bubble's id so the catch can finalize it in place (rather than orphan an
    // empty bubble) if the stream errors after it was appended.
    let liveId: string | null = null;
    try {
      if (inPatientMode) {
        // ── ANSWER path: stream the grounded answer token-by-token. Append a live bubble up front
        //    (it's the in-flight indicator), grow it on each token, finalize it on the result. ──
        const patientId = activePatient!.id;
        liveId = nextId();
        append({ id: liveId, role: 'assistant', text: '', agentName: 'answer-patient', patientId, streaming: true });
        scrollToEnd();
        await streamQaQuery(
          token,
          { question, history, patientId, sessionId },
          {
            onToken: (text) => {
              patchMessage(liveId!, { text });
              scrollToEnd();
            },
            onResult: (result) => {
              accumulateUsage(result.usage);
              finalizePatientAnswer(liveId!, result);
            },
            onError: () => {
              // Stream-level error (rare — the service degrades to a result internally). Read as a
              // generic notice in the live bubble.
              patchMessage(liveId!, {
                text: 'Something went wrong reaching the assistant.',
                pending: true,
                streaming: false,
              });
            },
          },
        );
        // Safety net: if the stream closed without a terminal event, don't leave the bubble stuck.
        patchMessage(liveId, { streaming: false });
      } else {
        // ── FIND path: unchanged — instant structured results / candidate cards. ──
        const result = await postQaQuery(token, { question, history, sessionId });
        accumulateUsage(result.usage);
        handleFindResult(result);
      }
    } catch (e) {
      // 401 ⇒ the session token is missing/expired/invalid — drop back to the picker to re-mint.
      if (e instanceof ApiError && e.status === 401) {
        onSwitchCohort();
        return;
      }
      const text = e instanceof ApiError ? e.message : 'Something went wrong reaching the assistant.';
      // Reuse the (empty) live bubble if we already appended one; otherwise add a fresh notice.
      if (liveId) patchMessage(liveId, { text, pending: true, streaming: false });
      else append({ id: nextId(), role: 'assistant', text, pending: true });
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

      {/* Pinned patient card — the active scope in the ASK phase: identity + at-a-glance counts,
          tap to open the full record, Change to pick another. The same result card, minimized. */}
      {mode === 'patient' && activePatient ? (
        <PinnedPatientCard
          patient={activePatient}
          accent={accent}
          onOpenRecord={() => setDetailPatient(activePatient)}
          onChange={backToSearch}
        />
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
              {m.candidates?.length ? (
                <YStack>
                  {m.candidates.map((item) => (
                    <PatientSummaryCard
                      key={item.patient.id}
                      patient={item.patient}
                      match={item.match}
                      accent={accent}
                      onDetails={() => setDetailPatient(item.patient)}
                      onAsk={() => chooseCandidate(item)}
                      // Once a patient is pinned, every card's Ask is inert — to switch, use "Change".
                      askDisabled={!!activePatient}
                    />
                  ))}
                  {/* Escape hatch for disambiguation (many hits): none of these → back to searching. */}
                  {m.candidates.length > 1 ? (
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
                  ) : null}
                </YStack>
              ) : null}
            </React.Fragment>
          ))}
          {/* Generic in-flight indicator for the FIND path only — the ANSWER path streams a live
              bubble (mode 'patient'), which is its own indicator, so skip the duplicate here. */}
          {pending && mode !== 'patient' ? (
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

        {/* Token-usage footer — always visible across phases; cumulative spend + context meter. */}
        <TokenUsageBar usage={usage} accent={accent} />

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
              Tap a patient above — View record to peek, or Ask to choose them
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

      {/* Full-record detail — opened from any result card or the active-patient bar. */}
      <PatientDetailModal
        patient={detailPatient}
        accent={accent}
        onClose={() => setDetailPatient(null)}
      />
    </Screen>
  );
}

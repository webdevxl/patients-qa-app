// Expandable detail view for a condition-search match.
//
// The condition search already returns each patient's FULL record in the list response, so
// tapping a match needs no extra request — this modal just renders the record we already hold
// with the same PatientCard used elsewhere.
import React from 'react';
import { Modal } from 'react-native';
import { ScrollView, YStack, XStack, Text } from 'tamagui';
import { PatientCard } from './PatientCard';
import type { PatientDetail } from '../api/client';
import { palette } from '../theme/palette';

export function PatientDetailModal({
  patient,
  accent,
  onClose,
}: {
  patient: PatientDetail | null;
  accent: string;
  onClose: () => void;
}) {
  const name = patient
    ? `${patient.nameFirst ?? ''} ${patient.nameLast ?? ''}`.trim()
    : '';

  return (
    <Modal
      visible={patient != null}
      animationType="slide"
      onRequestClose={onClose}
      transparent={false}
    >
      <YStack flex={1} backgroundColor={palette.systemGroupedBackground}>
        {/* Header — patient name + Done */}
        <XStack
          height={52}
          alignItems="center"
          paddingHorizontal={12}
          backgroundColor={palette.surface}
          borderBottomWidth={1}
          borderBottomColor={palette.hairline}
        >
          <Text
            flex={1}
            fontSize={16}
            fontWeight="700"
            color={palette.label}
            letterSpacing={-0.3}
            numberOfLines={1}
          >
            {name || 'Patient record'}
          </Text>
          <XStack
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Close patient record"
            cursor="pointer"
            animation="quick"
            pressStyle={{ opacity: 0.5 }}
            paddingVertical={6}
            paddingHorizontal={6}
            alignItems="center"
          >
            <Text fontSize={16} fontWeight="600" color={accent} letterSpacing={-0.2}>
              Done
            </Text>
          </XStack>
        </XStack>

        <ScrollView flex={1} contentContainerStyle={{ paddingBottom: 28 }}>
          {patient ? <PatientCard patient={patient} accent={accent} /> : null}
        </ScrollView>
      </YStack>
    </Modal>
  );
}

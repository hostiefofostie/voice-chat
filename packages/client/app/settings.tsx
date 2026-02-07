import React, { useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  ScrollView,
  StyleSheet,
  Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useConfigStore } from '../stores/configStore';
import type { SessionConfig } from '../lib/types';

// ---------------------------------------------------------------------------
// Slider (web-only range input)
// ---------------------------------------------------------------------------

function Slider({
  value,
  min,
  max,
  step,
  onValueChange,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onValueChange: (v: number) => void;
}) {
  if (Platform.OS === 'web') {
    return (
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onValueChange(parseFloat(e.target.value))}
        style={{
          flex: 1,
          accentColor: '#3b82f6',
          height: 20,
          cursor: 'pointer',
        }}
      />
    );
  }
  // Fallback for native — would need @react-native-community/slider
  return <Text style={{ color: '#9ca3af' }}>{value}</Text>;
}

// ---------------------------------------------------------------------------
// Picker (simple dropdown for web)
// ---------------------------------------------------------------------------

function Picker<T extends string>({
  value,
  options,
  onValueChange,
}: {
  value: T;
  options: { label: string; value: T }[];
  onValueChange: (v: T) => void;
}) {
  if (Platform.OS === 'web') {
    return (
      <select
        value={value}
        onChange={(e) => onValueChange(e.target.value as T)}
        style={{
          backgroundColor: '#0f1115',
          color: '#e5e7eb',
          border: '1px solid #1e293b',
          borderRadius: 8,
          padding: '8px 12px',
          fontSize: 14,
          minWidth: 140,
          cursor: 'pointer',
        }}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    );
  }
  // Fallback for native — would need @react-native-picker
  return <Text style={{ color: '#e5e7eb' }}>{value}</Text>;
}

// ---------------------------------------------------------------------------
// Settings Screen
// ---------------------------------------------------------------------------

const KOKORO_VOICES = [
  { label: 'Heart (F)', value: 'af_heart' },
  { label: 'Alloy (F)', value: 'af_alloy' },
  { label: 'Aoede (F)', value: 'af_aoede' },
  { label: 'Bella (F)', value: 'af_bella' },
  { label: 'Jessica (F)', value: 'af_jessica' },
  { label: 'Kore (F)', value: 'af_kore' },
  { label: 'Nicole (F)', value: 'af_nicole' },
  { label: 'Nova (F)', value: 'af_nova' },
  { label: 'River (F)', value: 'af_river' },
  { label: 'Sarah (F)', value: 'af_sarah' },
  { label: 'Sky (F)', value: 'af_sky' },
  { label: 'Adam (M)', value: 'am_adam' },
  { label: 'Echo (M)', value: 'am_echo' },
  { label: 'Eric (M)', value: 'am_eric' },
  { label: 'Fenrir (M)', value: 'am_fenrir' },
  { label: 'Liam (M)', value: 'am_liam' },
  { label: 'Michael (M)', value: 'am_michael' },
  { label: 'Onyx (M)', value: 'am_onyx' },
  { label: 'Puck (M)', value: 'am_puck' },
  { label: 'Santa (M)', value: 'am_santa' },
  { label: 'Alice (F, British)', value: 'bf_alice' },
  { label: 'Emma (F, British)', value: 'bf_emma' },
  { label: 'Isabella (F, British)', value: 'bf_isabella' },
  { label: 'Lily (F, British)', value: 'bf_lily' },
  { label: 'Daniel (M, British)', value: 'bm_daniel' },
  { label: 'Fable (M, British)', value: 'bm_fable' },
  { label: 'George (M, British)', value: 'bm_george' },
  { label: 'Lewis (M, British)', value: 'bm_lewis' },
];

export default function Settings() {
  const router = useRouter();
  const config = useConfigStore((s) => s.config);
  const updateConfig = useConfigStore((s) => s.updateConfig);

  const update = useCallback(
    (partial: Partial<SessionConfig>) => {
      updateConfig(partial);
    },
    [updateConfig],
  );

  return (
    <View style={styles.root}>
      {/* Header */}
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={8}>
          <Text style={styles.backText}>{'< Back'}</Text>
        </Pressable>
        <Text style={styles.headerTitle}>Settings</Text>
        <View style={{ width: 60 }} />
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
      >
        {/* ---- TTS Settings ---- */}
        <Text style={styles.sectionHeader}>TTS Settings</Text>
        <View style={styles.card}>
          <SettingRow label="Provider">
            <Picker
              value={config.ttsProvider}
              options={[
                { label: 'Kokoro', value: 'kokoro' as const },
                { label: 'OpenAI', value: 'openai' as const },
              ]}
              onValueChange={(v) => {
                const voice = v === 'kokoro' ? 'af_heart' : 'cedar';
                update({ ttsProvider: v, ttsVoice: voice });
              }}
            />
          </SettingRow>
          <View style={styles.divider} />
          <SettingRow label="Voice">
            {config.ttsProvider === 'kokoro' ? (
              <Picker
                value={config.ttsVoice}
                options={KOKORO_VOICES}
                onValueChange={(v) => update({ ttsVoice: v })}
              />
            ) : (
              <TextInput
                style={styles.input}
                value={config.ttsVoice}
                onChangeText={(v) => update({ ttsVoice: v })}
                placeholder="e.g. cedar"
                placeholderTextColor="#6b7280"
              />
            )}
          </SettingRow>
        </View>

        {/* ---- STT Settings ---- */}
        <Text style={styles.sectionHeader}>STT Settings</Text>
        <View style={styles.card}>
          <SettingRow label="Provider">
            <Picker
              value={config.sttProvider}
              options={[
                { label: 'Parakeet', value: 'parakeet' as const },
                { label: 'Cloud', value: 'cloud' as const },
              ]}
              onValueChange={(v) => update({ sttProvider: v })}
            />
          </SettingRow>
        </View>

        {/* ---- Turn Settings ---- */}
        <Text style={styles.sectionHeader}>Turn Settings</Text>
        <View style={styles.card}>
          <SettingRow
            label="Auto-send delay"
            detail={`${(config.autoSendDelayMs / 1000).toFixed(1)}s`}
          >
            <Slider
              value={config.autoSendDelayMs}
              min={0}
              max={10000}
              step={100}
              onValueChange={(v) => update({ autoSendDelayMs: v })}
            />
          </SettingRow>
          <View style={styles.divider} />
          <SettingRow
            label="VAD sensitivity"
            detail={config.vadSensitivity.toFixed(2)}
          >
            <Slider
              value={config.vadSensitivity}
              min={0}
              max={1}
              step={0.01}
              onValueChange={(v) =>
                update({ vadSensitivity: Math.round(v * 100) / 100 })
              }
            />
          </SettingRow>
        </View>

        {/* ---- Session ---- */}
        <Text style={styles.sectionHeader}>Session</Text>
        <View style={styles.card}>
          <SettingRow label="LLM Model">
            <TextInput
              style={styles.input}
              value={config.llmModel}
              onChangeText={(v) => update({ llmModel: v })}
              placeholder="e.g. sonnet"
              placeholderTextColor="#6b7280"
            />
          </SettingRow>
          <View style={styles.divider} />
          <SettingRow label="Session Key">
            <TextInput
              style={styles.input}
              value={config.sessionKey}
              onChangeText={(v) => update({ sessionKey: v })}
              placeholder="Optional routing key"
              placeholderTextColor="#6b7280"
            />
          </SettingRow>
        </View>

        <View style={{ height: 40 }} />
      </ScrollView>
    </View>
  );
}

// ---------------------------------------------------------------------------
// SettingRow component
// ---------------------------------------------------------------------------

function SettingRow({
  label,
  detail,
  children,
}: {
  label: string;
  detail?: string;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.row}>
      <View style={styles.rowLabelCol}>
        <Text style={styles.rowLabel}>{label}</Text>
        {detail != null && <Text style={styles.rowDetail}>{detail}</Text>}
      </View>
      <View style={styles.rowControl}>{children}</View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#0f1115',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#1e293b',
  },
  backText: {
    color: '#3b82f6',
    fontSize: 16,
    fontWeight: '500',
    width: 60,
  },
  headerTitle: {
    color: '#e5e7eb',
    fontSize: 17,
    fontWeight: '600',
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    padding: 16,
  },
  sectionHeader: {
    color: '#9ca3af',
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: 20,
    marginBottom: 8,
    marginLeft: 4,
  },
  card: {
    backgroundColor: '#151922',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#1e293b',
    overflow: 'hidden',
  },
  divider: {
    height: 1,
    backgroundColor: '#1e293b',
    marginLeft: 16,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    minHeight: 52,
  },
  rowLabelCol: {
    marginRight: 16,
    flexShrink: 0,
  },
  rowLabel: {
    color: '#e5e7eb',
    fontSize: 15,
  },
  rowDetail: {
    color: '#3b82f6',
    fontSize: 13,
    marginTop: 2,
    fontVariant: ['tabular-nums'],
  },
  rowControl: {
    flex: 1,
    alignItems: 'flex-end',
  },
  input: {
    backgroundColor: '#0f1115',
    color: '#e5e7eb',
    fontSize: 14,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: '#1e293b',
    minWidth: 140,
    textAlign: 'right',
  },
});

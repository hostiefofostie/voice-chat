import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Link } from 'expo-router';
import type { UseWebSocketReturn } from '../hooks/useWebSocket';

interface HeaderBarProps {
  ws: UseWebSocketReturn;
}

export default function HeaderBar({ ws }: HeaderBarProps) {
  return (
    <View style={styles.header}>
      <View style={styles.headerLeft}>
        <View
          style={[
            styles.connDot,
            ws.isConnected ? styles.connDotOnline : styles.connDotOffline,
          ]}
        />
        <Text style={styles.headerTitle}>
          {ws.isConnected
            ? ws.latencyMs !== null
              ? `${ws.latencyMs}ms`
              : 'Connected'
            : ws.isReconnecting
              ? 'Reconnecting...'
              : 'Disconnected'}
        </Text>
      </View>
      <Link href="/settings" asChild>
        <Pressable style={styles.gearBtn} hitSlop={8}>
          <Text style={styles.gearIcon}>{'\u2699\uFE0F'}</Text>
        </Pressable>
      </Link>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#1e293b',
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  connDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  connDotOnline: {
    backgroundColor: '#22c55e',
  },
  connDotOffline: {
    backgroundColor: '#ef4444',
  },
  headerTitle: {
    color: '#9ca3af',
    fontSize: 13,
  },
  gearBtn: {
    padding: 4,
  },
  gearIcon: {
    fontSize: 22,
  },
});

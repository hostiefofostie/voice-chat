import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

export default function RootLayout() {
  return (
    <>
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: '#1a1a2e' },
          headerTintColor: '#fff',
          headerTitleStyle: { fontWeight: 'bold' },
          contentStyle: { backgroundColor: '#16213e' },
        }}
      >
        <Stack.Screen name="index" options={{ title: 'Voice Chat' }} />
        <Stack.Screen name="settings" options={{ title: 'Settings' }} />
      </Stack>
      <StatusBar style="light" />
    </>
  );
}

import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { View, Platform, StyleSheet } from 'react-native';

export default function RootLayout() {
  const content = (
    <>
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: '#0f1115' },
        }}
      >
        <Stack.Screen name="index" />
        <Stack.Screen name="settings" />
      </Stack>
      <StatusBar style="light" />
    </>
  );

  if (Platform.OS === 'web') {
    return <View style={styles.webWrapper}>{content}</View>;
  }
  return content;
}

const styles = StyleSheet.create({
  webWrapper: {
    flex: 1,
    maxWidth: 720,
    width: '100%',
    alignSelf: 'center',
    backgroundColor: '#0f1115',
  },
});

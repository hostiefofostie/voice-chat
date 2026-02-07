import React from 'react';
import { TurnControllerProvider } from '../lib/TurnControllerContext';
import ChatScreen from '../components/ChatScreen';

export default function Index() {
  return (
    <TurnControllerProvider>
      <ChatScreen />
    </TurnControllerProvider>
  );
}

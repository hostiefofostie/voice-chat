import React, { useEffect, useRef } from 'react';
import ChatMessage from './ChatMessage';
import { useTurnStore } from '../stores/turnStore';

interface StreamingBubbleProps {
  onContentChange?: () => void;
}

/**
 * Isolated component that subscribes to llmText from the turn store.
 * Only this component re-renders during token streaming — not ChatHistory
 * or sibling ChatMessage components.
 */
export default function StreamingBubble({ onContentChange }: StreamingBubbleProps) {
  const llmText = useTurnStore((s) => s.llmText);
  const turnState = useTurnStore((s) => s.state);
  const isStreaming = turnState === 'thinking' || turnState === 'speaking';
  const prevLenRef = useRef(0);

  useEffect(() => {
    if (llmText.length > prevLenRef.current && onContentChange) {
      onContentChange();
    }
    prevLenRef.current = llmText.length;
  }, [llmText, onContentChange]);

  if (!isStreaming || !llmText) return null;

  return (
    <ChatMessage
      role="assistant"
      text={llmText}
      isStreaming={turnState === 'thinking'}
    />
  );
}

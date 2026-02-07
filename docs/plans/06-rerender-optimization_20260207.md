# Plan 06: Re-render Optimization

**Improvement:** #6 from the audit — Token streaming causes re-render storms
**Author:** client-refactor agent
**Date:** 2026-02-07

---

## Problem

### 1. Every `llm_token` triggers a full re-render cascade

The current flow:

1. Server sends `llm_token` message (up to ~100/sec for fast LLMs)
2. `onMessage` calls `appendLlmToken(token, fullText)` on `turnStore`
3. `turnStore` does `set({ llmText: fullText })`
4. Every component subscribing to `turnStore` re-renders
5. `ChatHistory` subscribes to `useTurnStore((s) => s.llmText)` and re-renders on every token
6. `ChatHistory`'s `useEffect` fires `scrollToEnd` on every `llmText` change (with a 50ms setTimeout each time)
7. All `ChatMessage` components inside `ChatHistory` re-render because the parent re-renders and they're not memoized

**Result:** At 100 tokens/sec, the component tree re-renders 100 times/sec. Each re-render:
- Re-evaluates the `messages.map()` in `ChatHistory`, creating new JSX for every historical message
- Triggers `scrollToEnd` with a new setTimeout (100 pending timers per second, each trying to scroll)
- Re-renders the streaming `ChatMessage` with the full accumulated text (not just the new token)

### 2. No virtualization

`ChatHistory` uses a plain `ScrollView` with `messages.map()`. Every message is rendered in the DOM at all times. After 500+ messages:
- Initial render creates 500+ `ChatMessage` components
- Every re-render (including from token streaming) re-evaluates all 500+ messages
- Memory grows linearly with conversation length
- Scroll performance degrades

### 3. ChatMessage is not memoized

`ChatMessage` is a default export without `React.memo`. Since `ChatHistory` re-renders on every token, and `messages.map()` creates new JSX elements each time, every historical message bubble re-renders even though its props haven't changed.

### 4. scrollToEnd fires too frequently

```typescript
useEffect(() => {
  const t = setTimeout(() => {
    scrollRef.current?.scrollToEnd({ animated: true });
  }, 50);
  return () => clearTimeout(t);
}, [messages.length, llmText]);
```

During token streaming, `llmText` changes ~100 times/sec. Each change:
- Creates a new 50ms timer
- Cancels the previous one (via cleanup)
- Net effect: scroll fires every ~50ms during streaming, which is fine — but only because the cleanup cancels stale timers. The real cost is that the `useEffect` itself runs 100 times/sec, creating/destroying timers.

---

## Solution

### Part A: Batch Zustand updates with requestAnimationFrame

Instead of updating `llmText` in the store on every `llm_token`, accumulate tokens and flush once per animation frame.

**Implementation in TurnController:**

```typescript
class TurnController {
  private pendingLlmText: string | null = null;
  private rafId: number | null = null;

  handleLlmToken(token: string, fullText: string) {
    this.pendingLlmText = fullText;
    this.errorStore.getState().reportLlmToken();

    if (this.rafId === null) {
      this.rafId = requestAnimationFrame(() => {
        this.rafId = null;
        if (this.pendingLlmText !== null) {
          this.turnStore.getState().appendLlmToken('', this.pendingLlmText);
          this.pendingLlmText = null;
        }
      });
    }
  }
}
```

**Effect:** At 100 tokens/sec and 60fps display, this reduces store updates from 100/sec to 60/sec. More importantly, it batches multiple tokens that arrive within the same frame into a single store update, which is what the user sees anyway.

**Important:** The `llm_done` handler must flush any pending text before adding the message to chat history:

```typescript
handleLlmDone(fullText: string) {
  // Cancel pending RAF and flush
  if (this.rafId !== null) {
    cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }
  this.pendingLlmText = null;

  this.chatStore.getState().addMessage({ role: 'assistant', text: fullText });
  this.turnStore.getState().appendLlmToken('', '');
  this.errorStore.getState().reportLlmDone();
}
```

### Part B: Isolate the streaming message component

The streaming message bubble (the one showing `llmText` with the blinking cursor) should be the **only** component that re-renders on token updates. Historical messages should not re-render.

**New component: `StreamingBubble`**

```typescript
// components/StreamingBubble.tsx
function StreamingBubble() {
  const llmText = useTurnStore((s) => s.llmText);
  const turnState = useTurnStore((s) => s.state);
  const isStreaming = turnState === 'thinking';

  if (!llmText) return null;

  return (
    <ChatMessage
      role="assistant"
      text={llmText}
      isStreaming={isStreaming}
    />
  );
}
```

This component subscribes directly to `llmText` from the turn store. When `llmText` changes, only this component re-renders — not the parent `ChatHistory` or sibling `ChatMessage` components.

**ChatHistory no longer subscribes to `llmText`:**

```typescript
function ChatHistory() {
  const messages = useChatStore((s) => s.messages);
  // NO subscription to llmText here

  return (
    <FlatList
      data={messages}
      renderItem={renderMessage}
      // ...
    />
    // StreamingBubble rendered as ListFooterComponent
  );
}
```

### Part C: Memoize ChatMessage

Wrap `ChatMessage` with `React.memo` to prevent re-renders when props haven't changed:

```typescript
export default React.memo(function ChatMessage({ role, text, isStreaming }: ChatMessageProps) {
  // ... existing implementation
});
```

Since `ChatMessage` receives primitive props (`role: string`, `text: string`, `isStreaming?: boolean`), the default shallow comparison works. Historical messages have stable props (their text doesn't change after being added to the store), so they will never re-render during token streaming.

### Part D: FlatList with virtualization

**Decision: FlatList over FlashList**

- **FlashList** (by Shopify) is faster for very large lists (10k+ items) due to its recycling architecture, but adds a dependency and has quirks with dynamic item heights (chat bubbles vary in height based on text length).
- **FlatList** is built into React Native, supports `getItemLayout` for fixed-height optimizations, handles dynamic heights well out of the box, and is sufficient for chat UIs up to ~5000 messages.
- **Verdict:** Use `FlatList` first. If profiling shows it's insufficient (unlikely for a voice chat app where messages are short), switch to FlashList later.

**Implementation:**

```typescript
import { FlatList } from 'react-native';

function ChatHistory() {
  const messages = useChatStore((s) => s.messages);
  const flatListRef = useRef<FlatList>(null);

  // Scroll to bottom when new messages are added
  const prevLengthRef = useRef(messages.length);
  useEffect(() => {
    if (messages.length > prevLengthRef.current) {
      flatListRef.current?.scrollToEnd({ animated: true });
    }
    prevLengthRef.current = messages.length;
  }, [messages.length]);

  return (
    <FlatList
      ref={flatListRef}
      data={messages}
      keyExtractor={(item) => item.id}
      renderItem={({ item }) => (
        <ChatMessage
          role={item.role}
          text={item.text}
          timestamp={item.timestamp}
        />
      )}
      ListFooterComponent={StreamingBubble}
      contentContainerStyle={styles.content}
      style={styles.container}
      // Performance tuning
      removeClippedSubviews={true}
      maxToRenderPerBatch={15}
      windowSize={11}
      initialNumToRender={20}
    />
  );
}
```

### Part E: Scroll-to-bottom with virtualization

With `ScrollView`, `scrollToEnd` always works because all items are rendered. With `FlatList`, `scrollToEnd` works correctly when:
1. A new message is added to `messages` (triggers `onContentSizeChange`)
2. The streaming bubble grows (but since it's a `ListFooterComponent`, FlatList doesn't track its height for scroll purposes)

**Solution for streaming scroll:**

The `StreamingBubble` component should notify the parent to scroll when its content changes. Use a callback or a simple approach:

```typescript
function StreamingBubble({ onContentChange }: { onContentChange?: () => void }) {
  const llmText = useTurnStore((s) => s.llmText);
  const prevLenRef = useRef(0);

  useEffect(() => {
    // Only scroll when text grows (not on clear)
    if (llmText.length > prevLenRef.current && onContentChange) {
      onContentChange();
    }
    prevLenRef.current = llmText.length;
  }, [llmText, onContentChange]);

  // ...render
}
```

In `ChatHistory`, the `onContentChange` callback throttles scroll calls:

```typescript
const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

const handleStreamingChange = useCallback(() => {
  // Throttle to max once per 200ms during streaming
  if (scrollTimerRef.current) return;
  scrollTimerRef.current = setTimeout(() => {
    scrollTimerRef.current = null;
    flatListRef.current?.scrollToEnd({ animated: false });
  }, 200);
}, []);
```

Using `animated: false` during streaming avoids animation jank. The 200ms throttle means scroll updates at 5fps during streaming, which is visually smooth for a chat list that's auto-scrolling.

### Part F: Efficient chat store updates

Currently `addMessage` creates a new array:
```typescript
addMessage: (msg) => set(state => ({
  messages: [...state.messages, { ...msg, id: crypto.randomUUID(), timestamp: Date.now() }]
}))
```

This is fine for `addMessage` (happens once per turn). But `setMessages` (called on `chat_history` from server) replaces the entire array, which is also fine.

The key optimization is that `useChatStore((s) => s.messages)` returns the same array reference unless a message is added/removed. Combined with `React.memo` on `ChatMessage`, FlatList's `renderItem` will skip re-rendering items whose data hasn't changed.

However, FlatList uses referential equality on `data` by default. Since `addMessage` creates a new array, FlatList will re-compare all items. To avoid this, we can **avoid changing the data reference** when only the streaming text changes (which we've already achieved by moving `llmText` out of `ChatHistory`'s subscriptions).

---

## Performance Testing Approach

### Before/after profiling

1. **React DevTools Profiler:** Record a session with ~50 messages and an LLM streaming response. Compare:
   - Number of renders per component during 5 seconds of token streaming
   - Time spent in each render

2. **Manual frame rate observation:** Open Chrome DevTools Performance tab, record during token streaming. Look at:
   - Main thread utilization
   - Frame drops (any frame > 16ms)
   - JS heap growth over a 100-message conversation

3. **Synthetic load test:** Add a test utility that simulates 100 `llm_token` messages/sec for 10 seconds. Measure:
   - Total re-renders of `ChatMessage` components (should be 0 for historical messages)
   - Store update frequency (should be ~60/sec with RAF batching, not 100/sec)
   - Memory delta

### Success criteria

- Historical `ChatMessage` components: **0 re-renders** during token streaming
- `ChatHistory` (parent): **0 re-renders** during token streaming (only `StreamingBubble` re-renders)
- Store updates during streaming: **<= 60/sec** (capped by RAF)
- Scroll-to-bottom: visually smooth, no jumps
- 500-message conversation: no perceptible lag when scrolling

---

## Migration Steps

1. **Memoize `ChatMessage`** with `React.memo`. This is a one-line change with immediate benefit.
2. **Extract `StreamingBubble` component** that subscribes to `llmText` independently.
3. **Update `ChatHistory`** to stop subscribing to `llmText`, render `StreamingBubble` as footer.
4. **Replace `ScrollView` with `FlatList`** in `ChatHistory`, add performance props.
5. **Implement scroll-to-bottom** with throttled callback from `StreamingBubble`.
6. **Add RAF batching** for `llm_token` in `TurnController` (depends on plan 01 being complete).
7. **Run `npm run typecheck`** to verify.
8. **Profile before/after** using React DevTools.

Steps 1-5 can be done independently of plan 01 (the god component refactor). Step 6 depends on the TurnController existing. Steps 1-3 provide the largest benefit and should be prioritized.

---

## Risks

1. **FlatList + dynamic heights.** Chat bubbles have variable height (text wraps). FlatList handles this, but `scrollToEnd` accuracy depends on estimated item heights. If items are much taller than estimated, `scrollToEnd` may not scroll far enough. Mitigation: use `onContentSizeChange` + `onLayout` to track actual content height, and call `scrollToOffset` with the exact offset.

2. **StreamingBubble flickering.** If `llmText` is cleared (set to `''`) between `llm_done` and the next turn, the streaming bubble may flash. Mitigation: the `StreamingBubble` component checks `llmText.length > 0` before rendering.

3. **Lost tokens with RAF batching.** If the component unmounts between a token arriving and the RAF firing, the final token could be lost. Mitigation: `llm_done` always carries the complete `fullText`, so it's the source of truth. The `handleLlmDone` method flushes and then adds the complete message to chat history.

4. **FlatList `removeClippedSubviews` bugs.** On some React Native versions, `removeClippedSubviews` can cause blank areas during fast scrolling. Mitigation: test on target platforms (web primarily). On web, `removeClippedSubviews` is a no-op in react-native-web, so this is only a risk for native builds.

5. **Integration with plan 01.** The RAF batching (step 6) lives in `TurnController`, which is created in plan 01. Steps 1-5 of this plan are independent and should be done first. If plan 01 is delayed, RAF batching can be implemented as a standalone wrapper around the `appendLlmToken` store method.

6. **Integration with state-arch plans.** Resolved in cross-review: Plan 02 does not change the `TurnState` type values. The `'thinking'` state remains. Plan 02 adds a `TurnEvent` type and changes how transitions are triggered, but `StreamingBubble` only reads state (via `useTurnStore((s) => s.state)`), it doesn't trigger transitions. Plan 03 is gateway-only. No impact on Plan 06.

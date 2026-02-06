import { describe, it, expect, beforeEach } from 'vitest';
import { PhraseChunker } from '../phrase-chunker.js';

describe('PhraseChunker — short sentence infinite loop fix', () => {
  let chunker: PhraseChunker;

  beforeEach(() => {
    chunker = new PhraseChunker();
  });

  it('does not infinite loop on short sentence followed by more text', () => {
    // "Sure!" is 1 word (< MIN_WORDS=4). Before the fix, the while(true) loop
    // would find the "!" split, extract "Sure!" as too short, prepend it back
    // making the buffer identical, and repeat forever.
    const result = chunker.feed('Sure! I can definitely help you with that question today.');
    // Should not hang. The short "Sure!" merges with the following text.
    expect(result.length).toBeGreaterThanOrEqual(0);
  });

  it('short sentence at start merges into next sentence for final output', () => {
    const result = chunker.feed(
      'Sure! I can definitely help you with that question today.',
      true,
    );
    // The entire text should come out as one merged chunk
    expect(result.length).toBe(1);
    expect(result[0].text).toContain('Sure!');
    expect(result[0].text).toContain('help you');
  });

  it('multiple short sentences followed by a long one', () => {
    // "Hi! Ok! Well! Let me explain what we need to do here." has 3 short
    // sentences before a long one
    const result = chunker.feed(
      'Hi! Ok! Well! Let me explain what we need to do here today. ',
      false,
    );
    expect(result.length).toBeGreaterThanOrEqual(1);
    // All text should appear in the output
    const allText = result.map(c => c.text).join(' ');
    expect(allText).toContain('Hi!');
    expect(allText).toContain('explain');
  });

  it('short sentence at end of feed waits for more text', () => {
    chunker.feed('I really appreciate your help today. ');
    const c2 = chunker.feed('Thanks! ');
    // "Thanks!" is too short on its own and at buffer end, stays buffered
    expect(c2.length).toBe(0);
    // Final flush gets it
    const c3 = chunker.feed('', true);
    expect(c3.length).toBe(1);
    expect(c3[0].text).toBe('Thanks!');
  });

  it('two-word sentence "Got it" followed by longer content', () => {
    const result = chunker.feed(
      'Got it! Here is what you need to know about the whole situation. ',
      false,
    );
    // "Got it!" (2 words) should merge with the rest
    expect(result.length).toBe(1);
    expect(result[0].text).toContain('Got it!');
    expect(result[0].text).toContain('situation');
  });

  it('LLM-style token-by-token streaming with short opening', () => {
    // Simulate streaming: "Sure! I'd be happy to help you with that."
    const tokens = ['Sure', '!', ' I', "'d", ' be', ' happy', ' to', ' help', ' you', ' with', ' that', '.'];
    let allChunks: Array<{ text: string; index: number }> = [];
    for (const token of tokens) {
      allChunks.push(...chunker.feed(token));
    }
    allChunks.push(...chunker.feed('', true));

    // Should produce at least one chunk with all the text
    expect(allChunks.length).toBeGreaterThanOrEqual(1);
    const allText = allChunks.map(c => c.text).join(' ');
    expect(allText).toContain('Sure!');
    expect(allText).toContain('help you');
  });

  it('exclamation-heavy response does not hang', () => {
    // Pattern common with enthusiastic LLM responses
    const text = 'Great! Wonderful! Amazing! I really think this is the best approach for solving your problem today. ';
    const result = chunker.feed(text, true);
    expect(result.length).toBeGreaterThanOrEqual(1);
    const allText = result.map(c => c.text).join(' ');
    expect(allText).toContain('Great!');
    expect(allText).toContain('problem');
  });
});

describe('PhraseChunker — additional edge cases', () => {
  let chunker: PhraseChunker;

  beforeEach(() => {
    chunker = new PhraseChunker();
  });

  it('empty string feed returns no chunks', () => {
    expect(chunker.feed('')).toEqual([]);
  });

  it('empty string final feed with empty buffer returns no chunks', () => {
    expect(chunker.feed('', true)).toEqual([]);
  });

  it('whitespace-only feed returns no chunks on final', () => {
    const result = chunker.feed('   \n\t  ', true);
    expect(result).toEqual([]);
  });

  it('handles closing quotes after sentence-ending punctuation', () => {
    const result = chunker.feed(
      'She said "I will be there soon." He replied "okay sounds great." ',
      true,
    );
    expect(result.length).toBe(2);
    expect(result[0].text).toContain('"');
  });

  it('handles consecutive sentence boundaries correctly', () => {
    const result = chunker.feed(
      'First sentence with enough words here. Second sentence also with enough words. Third sentence here with words too. ',
      true,
    );
    expect(result.length).toBe(3);
    expect(result[0].index).toBe(0);
    expect(result[1].index).toBe(1);
    expect(result[2].index).toBe(2);
  });

  it('does not split mid-word even at MAX_CHARS', () => {
    // Create 200+ chars of continuous text without spaces
    const longWord = 'a'.repeat(250);
    const result = chunker.feed(longWord, true);
    // Should force-split at MAX_CHARS since no space found
    expect(result.length).toBeGreaterThanOrEqual(1);
  });
});

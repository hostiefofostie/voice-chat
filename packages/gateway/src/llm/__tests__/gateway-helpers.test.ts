import { describe, it, expect } from 'vitest';
import { extractText, extractTextFromMessage, mergeDeltaText } from '../gateway-client.js';

// ---------------------------------------------------------------------------
// extractText
// ---------------------------------------------------------------------------

describe('extractText', () => {
  it('returns empty string for falsy values', () => {
    expect(extractText(null)).toBe('');
    expect(extractText(undefined)).toBe('');
    expect(extractText('')).toBe('');
    expect(extractText(0)).toBe('');
    expect(extractText(false)).toBe('');
  });

  it('returns string values directly', () => {
    expect(extractText('hello')).toBe('hello');
    expect(extractText('hello world')).toBe('hello world');
  });

  it('extracts text from {type:"text", text:"..."} objects', () => {
    expect(extractText({ type: 'text', text: 'hello' })).toBe('hello');
  });

  it('extracts text from plain {text:"..."} objects', () => {
    expect(extractText({ text: 'hello' })).toBe('hello');
  });

  it('recurses into content property', () => {
    expect(extractText({ content: 'hello' })).toBe('hello');
    expect(extractText({ content: { text: 'nested' } })).toBe('nested');
    expect(extractText({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] })).toBe('ab');
  });

  it('recurses into delta property', () => {
    expect(extractText({ delta: 'hello' })).toBe('hello');
    expect(extractText({ delta: { text: 'world' } })).toBe('world');
  });

  it('concatenates array elements', () => {
    expect(extractText(['hello', ' world'])).toBe('hello world');
    expect(extractText([
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
    ])).toBe('ab');
  });

  it('filters empty elements in arrays', () => {
    expect(extractText(['hello', null, '', 'world'])).toBe('helloworld');
  });

  it('returns empty string for non-text objects', () => {
    expect(extractText({ type: 'image', url: 'foo.png' })).toBe('');
    expect(extractText({ some: 'other' })).toBe('');
  });

  it('handles deeply nested structures', () => {
    const nested = {
      content: {
        delta: {
          content: [
            { type: 'text', text: 'deep' },
          ],
        },
      },
    };
    expect(extractText(nested)).toBe('deep');
  });

  it('prefers type=text pattern over generic text field', () => {
    // Both conditions match, but type=text is checked first
    const obj = { type: 'text', text: 'correct', content: 'wrong' };
    expect(extractText(obj)).toBe('correct');
  });

  it('returns empty for number/boolean/symbol types', () => {
    expect(extractText(42)).toBe('');
    expect(extractText(true)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// extractTextFromMessage
// ---------------------------------------------------------------------------

describe('extractTextFromMessage', () => {
  it('returns empty string for falsy values', () => {
    expect(extractTextFromMessage(null)).toBe('');
    expect(extractTextFromMessage(undefined)).toBe('');
    expect(extractTextFromMessage('')).toBe('');
  });

  it('returns string messages directly', () => {
    expect(extractTextFromMessage('hello')).toBe('hello');
  });

  it('extracts from assistant messages', () => {
    expect(extractTextFromMessage({ role: 'assistant', content: 'hi' })).toBe('hi');
  });

  it('returns empty for user messages', () => {
    expect(extractTextFromMessage({ role: 'user', content: 'hello' })).toBe('');
  });

  it('returns empty for system messages', () => {
    expect(extractTextFromMessage({ role: 'system', content: 'system prompt' })).toBe('');
  });

  it('handles authorRole field', () => {
    expect(extractTextFromMessage({ authorRole: 'assistant', text: 'hi' })).toBe('hi');
    expect(extractTextFromMessage({ authorRole: 'user', text: 'hi' })).toBe('');
  });

  it('handles nested author.role field', () => {
    expect(extractTextFromMessage({
      author: { role: 'assistant' },
      content: 'hello',
    })).toBe('hello');
    expect(extractTextFromMessage({
      author: { role: 'user' },
      content: 'hello',
    })).toBe('');
  });

  it('extracts from messages without role (assumes assistant)', () => {
    // No role at all → role is undefined → the `if (role && role !== 'assistant')` check passes
    expect(extractTextFromMessage({ content: 'no role here' })).toBe('no role here');
  });

  it('handles array messages', () => {
    expect(extractTextFromMessage([
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
    ])).toBe('ab');
  });

  it('tries delta field when content and text are missing', () => {
    expect(extractTextFromMessage({ role: 'assistant', delta: 'streaming' })).toBe('streaming');
  });

  it('falls through to extractText(message) when no known fields exist', () => {
    // An object with role=assistant but no content/text/delta → falls through to extractText on the whole object
    expect(extractTextFromMessage({ role: 'assistant', type: 'text', text: 'found it' })).toBe('found it');
  });
});

// ---------------------------------------------------------------------------
// mergeDeltaText
// ---------------------------------------------------------------------------

describe('mergeDeltaText', () => {
  it('returns buffer when next is empty/falsy', () => {
    expect(mergeDeltaText('hello', '')).toBe('hello');
    expect(mergeDeltaText('hello', undefined as unknown as string)).toBe('hello');
  });

  it('returns next when buffer is empty/falsy', () => {
    expect(mergeDeltaText('', 'hello')).toBe('hello');
    expect(mergeDeltaText(undefined as unknown as string, 'hello')).toBe('hello');
  });

  it('returns buffer when identical', () => {
    expect(mergeDeltaText('hello', 'hello')).toBe('hello');
  });

  it('returns next when it starts with buffer (progressive growth)', () => {
    expect(mergeDeltaText('hello', 'hello world')).toBe('hello world');
  });

  it('returns buffer when buffer starts with next (already ahead)', () => {
    expect(mergeDeltaText('hello world', 'hello')).toBe('hello world');
  });

  it('returns buffer when buffer contains next', () => {
    expect(mergeDeltaText('the hello world text', 'hello world')).toBe('the hello world text');
  });

  it('returns next when next contains buffer', () => {
    expect(mergeDeltaText('world', 'hello world text')).toBe('hello world text');
  });

  it('merges overlapping text', () => {
    expect(mergeDeltaText('hello wor', 'world')).toBe('hello world');
    expect(mergeDeltaText('abc', 'cde')).toBe('abcde');
  });

  it('concatenates non-overlapping text', () => {
    expect(mergeDeltaText('hello', ' world')).toBe('hello world');
    expect(mergeDeltaText('abc', 'xyz')).toBe('abcxyz');
  });

  it('handles single character overlap', () => {
    expect(mergeDeltaText('ab', 'bc')).toBe('abc');
  });

  it('handles full overlap (buffer ends where next begins)', () => {
    expect(mergeDeltaText('first part ', 'part second')).toBe('first part second');
  });

  it('handles both empty', () => {
    expect(mergeDeltaText('', '')).toBe('');
  });
});

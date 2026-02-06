import { describe, it, expect, beforeEach } from 'vitest';
import { PhraseChunker } from '../phrase-chunker.js';

describe('PhraseChunker', () => {
  let chunker: PhraseChunker;

  beforeEach(() => {
    chunker = new PhraseChunker();
  });

  describe('sentence splitting', () => {
    it('splits on period', () => {
      const chunks = chunker.feed(
        'Hello there friend today. World is great indeed today. ',
        true,
      );
      expect(chunks.length).toBe(2);
      expect(chunks[0].text).toBe('Hello there friend today.');
      expect(chunks[1].text).toBe('World is great indeed today.');
    });

    it('splits on exclamation mark', () => {
      const chunks = chunker.feed(
        'What a wonderful day today! I love it so much! ',
        true,
      );
      expect(chunks.length).toBe(2);
      expect(chunks[0].text).toBe('What a wonderful day today!');
      expect(chunks[1].text).toBe('I love it so much!');
    });

    it('splits on question mark', () => {
      const chunks = chunker.feed(
        'How are you doing today? I am doing fine thanks. ',
        true,
      );
      expect(chunks.length).toBe(2);
      expect(chunks[0].text).toBe('How are you doing today?');
      expect(chunks[1].text).toBe('I am doing fine thanks.');
    });

    it('handles ellipsis as sentence end', () => {
      const chunks = chunker.feed(
        'Well I was thinking about... And then it happened right here. ',
        true,
      );
      expect(chunks.length).toBe(2);
      expect(chunks[0].text).toBe('Well I was thinking about...');
      expect(chunks[1].text).toBe('And then it happened right here.');
    });

    it('assigns sequential chunk indices', () => {
      const chunks = chunker.feed(
        'First sentence is right here. Second sentence follows now. ',
        true,
      );
      expect(chunks[0].index).toBe(0);
      expect(chunks[1].index).toBe(1);
    });
  });

  describe('abbreviations', () => {
    it('does not split after Dr.', () => {
      const chunks = chunker.feed(
        'Dr. Smith went to the store today. He bought some apples there. ',
        true,
      );
      expect(chunks[0].text).toBe('Dr. Smith went to the store today.');
      expect(chunks[1].text).toBe('He bought some apples there.');
    });

    it('does not split after e.g.', () => {
      const chunks = chunker.feed(
        'Use a framework e.g. React for building your application today. ',
        true,
      );
      expect(chunks.length).toBe(1);
      expect(chunks[0].text).toContain('e.g.');
    });

    it('does not split after Mr.', () => {
      const chunks = chunker.feed(
        'Mr. Jones is here right now. He has an appointment today. ',
        true,
      );
      expect(chunks[0].text).toBe('Mr. Jones is here right now.');
    });

    it('does not split after etc.', () => {
      const chunks = chunker.feed(
        'Bring pens pencils notebooks etc. to class tomorrow morning. ',
        true,
      );
      expect(chunks.length).toBe(1);
      expect(chunks[0].text).toContain('etc.');
    });

    it('does not split after i.e.', () => {
      const chunks = chunker.feed(
        'The best option i.e. the first one is clearly the best choice. ',
        true,
      );
      expect(chunks.length).toBe(1);
      expect(chunks[0].text).toContain('i.e.');
    });
  });

  describe('numbered lists', () => {
    it('does not split on numbered list periods', () => {
      const chunks = chunker.feed(
        '1. First item in the list 2. Second item in the list here ',
        true,
      );
      expect(chunks.length).toBe(1);
    });
  });

  describe('long sentences', () => {
    it('splits at comma for >100 char sentence', () => {
      const longSentence =
        'This is a really long sentence that goes on and on without any period or exclamation mark, and it continues for quite a while until we reach the end';
      const chunks = chunker.feed(longSentence, true);
      expect(chunks.length).toBeGreaterThanOrEqual(2);
      expect(chunks[0].text).toContain(',');
    });

    it('splits at semicolon for >100 char sentence', () => {
      const longSentence =
        'This is a really long sentence that just keeps going and going without stopping at all; then it continues for even longer here';
      const chunks = chunker.feed(longSentence, true);
      expect(chunks.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('min/max chunk size', () => {
    it('short chunk merges with following content', () => {
      // Feed a short sentence followed by a longer one in subsequent calls.
      // The short sentence should merge with the next content.
      // "Ok. " is 1 word, gets prepended to buffer
      // Then "So this is the rest of the much longer sentence here." makes
      // the merged text long enough to emit.
      const c1 = chunker.feed('Ok. So this is the rest of the much longer sentence here. ', false);
      // "Ok." (1 word) gets split then prepended, then the combined buffer
      // "Ok. So this is the rest of the much longer sentence here. " finds
      // the sentence end at the final period and emits the merged chunk
      expect(c1.length).toBe(1);
      expect(c1[0].text).toContain('Ok.');
    });

    it('emits short chunk on final flush', () => {
      const chunks = chunker.feed('OK bye', true);
      expect(chunks.length).toBe(1);
      expect(chunks[0].text).toBe('OK bye');
    });

    it('sentences with exactly 4 words are emitted', () => {
      const chunks = chunker.feed('This has four words. Another four word sentence. ', true);
      expect(chunks.length).toBe(2);
      expect(chunks[0].text).toBe('This has four words.');
      expect(chunks[1].text).toBe('Another four word sentence.');
    });

    it('force splits at ~200 chars', () => {
      const longText = 'word '.repeat(50); // 250 chars, no sentence end
      const chunks = chunker.feed(longText, true);
      expect(chunks.length).toBeGreaterThanOrEqual(2);
      expect(chunks[0].text.length).toBeLessThanOrEqual(200);
    });
  });

  describe('special content', () => {
    it('preserves code blocks (no split inside)', () => {
      const text =
        'Here is some code:\n```\nconst x = 1;\nconst y = 2;\n```\nThat was the code example right here. ';
      const chunks = chunker.feed(text, true);
      expect(chunks.length).toBeGreaterThanOrEqual(1);
      const allText = chunks.map((c) => c.text).join(' ');
      expect(allText).toContain('```');
    });

    it('does not split inside unclosed code block', () => {
      const text = 'Look at this:\n```\nfunction hello() { return "hi"; }\n';
      const chunks = chunker.feed(text, false);
      expect(chunks.length).toBe(0);
    });

    it('preserves URLs (no split at dots in URLs)', () => {
      const text =
        'Visit https://example.com/path/to/page.html for more information about this topic. ';
      const chunks = chunker.feed(text, true);
      const allText = chunks.map((c) => c.text).join(' ');
      expect(allText).toContain('https://example.com/path/to/page.html');
    });

    it('does not split at period inside URL', () => {
      const text =
        'Check out https://www.example.org for the latest info right now. And do it soon. ';
      const chunks = chunker.feed(text, true);
      const firstChunk = chunks[0].text;
      expect(firstChunk).toContain('https://www.example.org');
    });
  });

  describe('streaming', () => {
    it('final flush emits remaining buffer', () => {
      chunker.feed('Start of a sentence that is long enough to count ');
      const final = chunker.feed('and now it ends here.', true);
      expect(final.length).toBeGreaterThanOrEqual(1);
      const allText = final.map((c) => c.text).join(' ');
      expect(allText).toContain('ends here.');
    });

    it('incremental feed produces chunks as sentences complete', () => {
      const c1 = chunker.feed('Hello there my good friend. ');
      expect(c1.length).toBe(1);
      expect(c1[0].text).toBe('Hello there my good friend.');

      const c2 = chunker.feed('World is wonderful and nice. ');
      expect(c2.length).toBe(1);
      expect(c2[0].text).toBe('World is wonderful and nice.');
      expect(c2[0].index).toBe(1);
    });

    it('holds incomplete sentence until more text arrives', () => {
      const c1 = chunker.feed('This is an incomplete');
      expect(c1.length).toBe(0);

      const c2 = chunker.feed(' sentence that just keeps going. ');
      expect(c2.length).toBe(1);
      expect(c2[0].text).toBe(
        'This is an incomplete sentence that just keeps going.',
      );
    });

    it('reset clears buffer and index', () => {
      chunker.feed('Hello there my good friend. ');
      chunker.reset();
      const chunks = chunker.feed('New start for the new sentence. ', true);
      expect(chunks[0].index).toBe(0);
    });
  });
});

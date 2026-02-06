import { PhraseChunk } from '../types.js';

export class PhraseChunker {
  private buffer: string = '';
  private chunkIndex: number = 0;

  private static readonly MIN_WORDS = 4;
  private static readonly MAX_CHARS = 200;

  private static readonly ABBREVIATIONS = new Set([
    'mr.', 'mrs.', 'ms.', 'dr.', 'prof.', 'sr.', 'jr.',
    'e.g.', 'i.e.', 'etc.', 'vs.', 'approx.', 'dept.',
    'est.', 'inc.', 'ltd.', 'st.', 'ave.', 'blvd.',
  ]);

  /** Feed new text from the LLM stream. Returns any complete chunks. */
  feed(text: string, isFinal: boolean = false): PhraseChunk[] {
    this.buffer += text;
    const chunks: PhraseChunk[] = [];
    let searchFrom = 0;

    while (true) {
      const split = this.findSplitPoint(searchFrom);
      if (split === -1) break;

      const chunk = this.buffer.substring(0, split).trim();

      if (chunk && this.wordCount(chunk) >= PhraseChunker.MIN_WORDS) {
        this.buffer = this.buffer.substring(split);
        searchFrom = 0;
        chunks.push({ text: chunk, index: this.chunkIndex++ });
      } else {
        // Chunk is too short — skip past this split point and look for the
        // next boundary.  The short prefix will merge with the following
        // text into a larger chunk.  Without this guard the loop would
        // infinite-loop: split → prepend → same split → repeat.
        searchFrom = split;
      }
    }

    if (isFinal && this.buffer.trim()) {
      chunks.push({ text: this.buffer.trim(), index: this.chunkIndex++ });
      this.buffer = '';
    }

    return chunks;
  }

  /** Reset state between responses. */
  reset(): void {
    this.buffer = '';
    this.chunkIndex = 0;
  }

  // ---------------------------------------------------------------------------
  // Split-point detection
  // ---------------------------------------------------------------------------

  private findSplitPoint(startFrom: number = 0): number {
    const buf = this.buffer;
    if (buf.length === 0) return -1;

    // If we are inside an unclosed code block, don't split at all
    if (this.insideCodeBlock()) return -1;

    // 1. Try sentence boundaries (. ! ? ...)
    const sentenceEnd = this.findSentenceBoundary(startFrom);
    if (sentenceEnd !== -1) return sentenceEnd;

    // 2. For long buffers, try pause-point splits (comma, semicolon, em-dash, colon)
    if (buf.length > 100) {
      const pauseEnd = this.findPauseBoundary(startFrom);
      if (pauseEnd !== -1) return pauseEnd;
    }

    // 3. For very long buffers, force a split at the nearest word boundary
    if (buf.length > PhraseChunker.MAX_CHARS) {
      return this.findForcedSplit(startFrom);
    }

    return -1;
  }

  /**
   * Find the first valid sentence-ending boundary in the buffer.
   * Returns the index *after* the boundary (i.e. where the next chunk starts).
   */
  private findSentenceBoundary(startFrom: number = 0): number {
    const buf = this.buffer;

    for (let i = startFrom; i < buf.length; i++) {
      // Skip characters inside URLs
      if (this.isInsideUrl(i)) continue;

      const ch = buf[i];

      // Ellipsis: treat as sentence end
      if (ch === '.' && buf[i + 1] === '.' && buf[i + 2] === '.') {
        const end = i + 3;
        // Consume any trailing whitespace
        return this.advancePastWhitespace(end);
      }

      if (ch === '.' || ch === '!' || ch === '?') {
        // Check for numbered list pattern like "1. " or "12. "
        if (ch === '.' && this.isNumberedList(i)) continue;

        // Check for abbreviation
        if (ch === '.' && this.isAbbreviation(i)) continue;

        // Valid sentence end -- advance past closing quotes/parens and whitespace
        let end = i + 1;
        while (end < buf.length && (buf[end] === '"' || buf[end] === '\'' || buf[end] === ')' || buf[end] === '\u201D')) {
          end++;
        }

        // Need at least one whitespace or end-of-buffer after to confirm sentence end
        if (end >= buf.length) {
          // At end of buffer -- only split if we have enough content
          if (this.wordCount(buf.substring(0, end)) >= PhraseChunker.MIN_WORDS) {
            return end;
          }
          continue;
        }

        if (/\s/.test(buf[end])) {
          return this.advancePastWhitespace(end);
        }
      }
    }

    return -1;
  }

  /**
   * Find a pause-point split (comma, semicolon, colon, em-dash) in the buffer.
   * Only used when buffer exceeds 100 chars without a sentence boundary.
   * Searches from the end backward to get the longest possible chunk under MAX_CHARS.
   */
  private findPauseBoundary(startFrom: number = 0): number {
    const buf = this.buffer;
    const limit = Math.min(buf.length, PhraseChunker.MAX_CHARS);

    // Search backward from the limit to find a pause point
    for (let i = limit - 1; i >= startFrom; i--) {
      if (this.isInsideUrl(i)) continue;

      const ch = buf[i];
      if (ch === ',' || ch === ';' || ch === ':' || ch === '\u2014') {
        const candidate = i + 1;
        const before = buf.substring(0, candidate).trim();
        if (this.wordCount(before) >= PhraseChunker.MIN_WORDS) {
          return this.advancePastWhitespace(candidate);
        }
      }
    }

    return -1;
  }

  /**
   * Force a split at a word boundary when the buffer exceeds MAX_CHARS.
   */
  private findForcedSplit(startFrom: number = 0): number {
    const buf = this.buffer;
    // Find the last space between startFrom and MAX_CHARS
    let lastSpace = -1;
    for (let i = Math.max(startFrom, 0); i < PhraseChunker.MAX_CHARS && i < buf.length; i++) {
      if (buf[i] === ' ') lastSpace = i;
    }
    if (lastSpace > 0) {
      return this.advancePastWhitespace(lastSpace);
    }
    // No space found after startFrom — split at MAX_CHARS if we haven't passed it
    if (startFrom < PhraseChunker.MAX_CHARS) return PhraseChunker.MAX_CHARS;
    return -1;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Check if the buffer contains an unclosed code block (triple backtick). */
  private insideCodeBlock(): boolean {
    let count = 0;
    let i = 0;
    const buf = this.buffer;
    while (i < buf.length - 2) {
      if (buf[i] === '`' && buf[i + 1] === '`' && buf[i + 2] === '`') {
        count++;
        i += 3;
      } else {
        i++;
      }
    }
    // Odd count means we're inside an unclosed code block
    return count % 2 === 1;
  }

  /** Check if position i is inside a URL (http:// or https://). */
  private isInsideUrl(i: number): boolean {
    const buf = this.buffer;
    // Walk backward from i to find if we're between "http(s)://" and the next whitespace
    const before = buf.substring(0, i + 1);
    const httpIdx = before.lastIndexOf('http');
    if (httpIdx === -1) return false;

    // Check that everything between httpIdx and i has no whitespace
    const segment = buf.substring(httpIdx, i + 1);
    if (/\s/.test(segment)) return false;

    // Confirm it's actually a URL (has ://)
    const afterHttp = buf.substring(httpIdx);
    return /^https?:\/\//.test(afterHttp);
  }

  /** Check if the period at position i is part of a numbered list (e.g., "1. "). */
  private isNumberedList(dotIndex: number): boolean {
    if (dotIndex === 0) return false;
    // Walk backward from the dot -- if we hit only digits (and then start-of-buffer or whitespace/newline), it's a numbered list
    let j = dotIndex - 1;
    while (j >= 0 && /\d/.test(this.buffer[j])) {
      j--;
    }
    // j is now at a non-digit or -1
    if (j === dotIndex - 1) return false; // no digits before the dot
    // The character before the digits must be start-of-buffer, newline, or whitespace
    if (j < 0 || /[\s\n]/.test(this.buffer[j])) {
      // And the character after the dot must be a space
      return dotIndex + 1 < this.buffer.length && this.buffer[dotIndex + 1] === ' ';
    }
    return false;
  }

  /** Check if the period at position i terminates an abbreviation. */
  private isAbbreviation(dotIndex: number): boolean {
    // Extract the word ending at this dot
    let start = dotIndex - 1;
    // Walk back to capture multi-dot abbreviations like "e.g." or single-word ones like "Dr."
    while (start >= 0 && this.buffer[start] !== ' ' && this.buffer[start] !== '\n') {
      start--;
    }
    start++; // move past the space/newline

    const word = this.buffer.substring(start, dotIndex + 1).toLowerCase();
    return PhraseChunker.ABBREVIATIONS.has(word);
  }

  /** Advance the index past any whitespace characters. */
  private advancePastWhitespace(index: number): number {
    while (index < this.buffer.length && /\s/.test(this.buffer[index])) {
      index++;
    }
    return index;
  }

  private wordCount(text: string): number {
    return text.split(/\s+/).filter(Boolean).length;
  }
}

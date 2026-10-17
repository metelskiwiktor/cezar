import { sanitizeAttachmentName } from '@open-mercato/cezar-contract';
import { describe, expect, it } from 'vitest';

// CodeQL #2 (js/polynomial-redos): the stem's trailing-dot/space strip is a linear loop now, not
// `/[. ]+$/`. Same answers as the regex gave.
describe('sanitizeAttachmentName — trailing dots and spaces', () => {
  it('strips them from the end of the stem, and only there', () => {
    expect(sanitizeAttachmentName('notes. . .txt', 'text/plain')).toBe('notes.txt');
    expect(sanitizeAttachmentName('a. b.txt', 'text/plain')).toBe('a. b.txt');
    expect(sanitizeAttachmentName(' . . .txt', 'text/plain')).toBeNull();
  });

  it('stays fast on a long run of spaces', () => {
    expect(sanitizeAttachmentName(`x${' '.repeat(50_000)}y.txt`, 'text/plain')).toBe('x y.txt');
  });
});

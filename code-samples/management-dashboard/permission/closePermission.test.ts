import { describe, expect, it } from 'vitest';
import { canCloseMonth } from './closePermission';

describe('canCloseMonth', () => {
  it.each(['owner@example.com', 'manager@example.com'])('%s can close', (email: string) => {
    expect(canCloseMonth(email)).toBe(true);
  });

  it.each(['staff@example.com', null, undefined, '', 'OWNER@example.com'])(
    '%s cannot close',
    (email: string | null | undefined) => {
      expect(canCloseMonth(email)).toBe(false);
    }
  );
});

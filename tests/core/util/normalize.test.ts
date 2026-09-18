import { describe, expect, it } from 'vitest';
import { normalize } from '../../../src/core/util/normalize';

describe('normalize', () => {
  it('lower-cases', () => {
    expect(normalize('Beast-Warrior')).toBe('beast-warrior');
  });

  it('strips diacritics', () => {
    expect(normalize('Élégant Égotiste')).toBe('elegant egotiste');
  });

  it('strips combining marks that arrive already decomposed', () => {
    expect(normalize('é')).toBe('e');
  });

  it('leaves punctuation and digits alone', () => {
    expect(normalize('Nibiru, the Primal Being #27')).toBe('nibiru, the primal being #27');
  });

  it('is idempotent', () => {
    const once = normalize('Ñandú Ärger');
    expect(normalize(once)).toBe(once);
  });
});

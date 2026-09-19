import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateTemplate } from '../../../../src/core/model/template';
import { EXAMPLE_TEMPLATE } from '../../../../src/renderer/src/model/example-template';
import { MOTIVATING_PATH } from '../../../helpers/motivating';

describe('EXAMPLE_TEMPLATE', () => {
  it('is examples/motivating.json, word for word: the renderer cannot read files, so it carries a copy', () => {
    expect(EXAMPLE_TEMPLATE).toEqual(JSON.parse(readFileSync(MOTIVATING_PATH, 'utf8')));
  });

  it('is a valid template', () => {
    expect(validateTemplate(EXAMPLE_TEMPLATE)).toMatchObject({ ok: true });
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateTemplate } from '../../../../src/core/model/template';
import {
  EXAMPLE_TEMPLATE,
  exampleTemplate,
} from '../../../../src/renderer/src/model/example-template';
import { MOTIVATING_PATH } from '../../../helpers/motivating';

describe('EXAMPLE_TEMPLATE', () => {
  it('is examples/motivating.json, word for word: the renderer cannot read files, so it carries a copy', () => {
    expect(EXAMPLE_TEMPLATE).toEqual(JSON.parse(readFileSync(MOTIVATING_PATH, 'utf8')));
  });

  it('is a valid template', () => {
    expect(validateTemplate(EXAMPLE_TEMPLATE)).toMatchObject({ ok: true });
  });
});

describe('exampleTemplate', () => {
  it('is the example', () => {
    expect(exampleTemplate()).toEqual(EXAMPLE_TEMPLATE);
  });

  it('is a FRESH copy each time, so an edit cannot rewrite the example', () => {
    const loaded = exampleTemplate();
    loaded.lines[0]!.min = 3;
    loaded.lines.push({ id: 'extra', text: 'trap', min: 0, max: 3 });
    loaded.groups.push({ id: 'g1', name: 'starter', cards: [] });
    expect(exampleTemplate()).toEqual(EXAMPLE_TEMPLATE);
    expect(EXAMPLE_TEMPLATE.lines[0]).toMatchObject({ min: 0 });
    expect(EXAMPLE_TEMPLATE.lines).toHaveLength(7);
    expect(EXAMPLE_TEMPLATE.groups).toEqual([]);
  });

  it('shares no array with the copy before it', () => {
    expect(exampleTemplate().lines).not.toBe(exampleTemplate().lines);
  });
});

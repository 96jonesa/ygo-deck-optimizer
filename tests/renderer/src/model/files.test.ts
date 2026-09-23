import { describe, expect, it } from 'vitest';
import {
  exportStatus,
  importStatus,
  openStatus,
  saveStatus,
} from '../../../../src/renderer/src/model/files';
import type { Template } from '../../../../src/shared/types';

const TEMPLATE: Template = {
  version: 2,
  deckSize: 40,
  hand: { size: 5 },
  groups: [],
  lines: [],
  remainder: { min: 0, max: null },
  criteria: [],
};

describe('importStatus', () => {
  it('says what the deck became', () => {
    expect(
      importStatus({
        ok: true,
        template: TEMPLATE,
        deck: { name: 'Cyber Dragon', mainSize: 40, distinct: 26 },
        warnings: [],
      }),
    ).toEqual({
      tone: 'ok',
      lines: [
        'Cyber Dragon: 40 cards, 26 lines. The criteria and groups are unchanged — widen the copies you are unsure of, then run.',
      ],
    });
  });

  it('carries every warning under the headline', () => {
    const status = importStatus({
      ok: true,
      template: TEMPLATE,
      deck: { name: 'Odd', mainSize: 38, distinct: 20 },
      warnings: ['the main deck holds 38 cards'],
    });
    expect(status?.tone).toBe('ok');
    expect(status?.lines[1]).toBe('the main deck holds 38 cards');
  });

  it('says nothing at all about a cancelled dialog', () => {
    expect(importStatus({ ok: false, reason: 'cancelled' })).toBeNull();
  });

  it('reports a failure in the tone of one', () => {
    expect(importStatus({ ok: false, reason: 'read', message: 'no such deck' })).toEqual({
      tone: 'bad',
      lines: ['no such deck'],
    });
    expect(
      importStatus({ ok: false, reason: 'not-ready', state: 'loading', message: 'still loading' }),
    ).toEqual({ tone: 'bad', lines: ['still loading'] });
    expect(
      importStatus({
        ok: false,
        reason: 'invalid',
        message: 'bad',
        errors: ['`name` must be text'],
      }),
    ).toEqual({ tone: 'bad', lines: ['bad', '`name` must be text'] });
  });
});

describe('openStatus', () => {
  it('names the file it came from', () => {
    expect(
      openStatus({ ok: true, template: TEMPLATE, path: '/a/b/deck.json', notices: [] }),
    ).toEqual({ tone: 'ok', lines: ['Opened /a/b/deck.json.'] });
  });

  it('keeps the card-data notices, which are the point of the snapshot', () => {
    const status = openStatus({
      ok: true,
      template: TEMPLATE,
      path: '/a/b.json',
      notices: ['Ash (#1) differs from the file’s record of it'],
    });
    expect(status?.lines).toHaveLength(2);
    expect(status?.tone).toBe('ok');
  });

  it('says nothing about a cancelled dialog', () => {
    expect(openStatus({ ok: false, reason: 'cancelled' })).toBeNull();
  });
});

describe('saveStatus', () => {
  it('says where it went', () => {
    expect(saveStatus({ ok: true, path: '/a/b.json', warnings: [] })).toEqual({
      tone: 'ok',
      lines: ['Saved to /a/b.json.'],
    });
  });

  it('carries the warnings of a template that does not wholly parse', () => {
    const status = saveStatus({
      ok: true,
      path: '/a/b.json',
      warnings: ['line "l1" does not parse'],
    });
    expect(status?.lines[1]).toBe('line "l1" does not parse');
  });

  it('reports a write that failed', () => {
    expect(saveStatus({ ok: false, reason: 'write', message: 'EACCES' })).toEqual({
      tone: 'bad',
      lines: ['EACCES'],
    });
  });
});

describe('exportStatus', () => {
  it('says where the file went', () => {
    expect(exportStatus({ ok: true, path: '/a/results.csv' })).toEqual({
      tone: 'ok',
      lines: ['Exported to /a/results.csv.'],
    });
  });

  it('says when the run is no longer the one that can be exported', () => {
    expect(exportStatus({ ok: false, reason: 'no-run', message: 'run again' })).toEqual({
      tone: 'bad',
      lines: ['run again'],
    });
  });

  it('says nothing about a cancelled dialog', () => {
    expect(exportStatus({ ok: false, reason: 'cancelled' })).toBeNull();
  });
});

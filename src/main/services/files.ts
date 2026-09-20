import * as nodeFs from 'node:fs';
import path from 'node:path';
import { groupLookupOf } from '../../core/model/compile';
import { validateTemplate } from '../../core/model/template';
import { snapshotNotices, templateToFile } from '../../core/model/template-file';
import type {
  ExportFormat,
  NotReady,
  ResultsExportResult,
  RunResult,
  TemplateOpenResult,
  TemplateSaveResult,
} from '../../shared/types';
import type { CardSource } from './templates';

// Template files and result exports (TDD §12, §14). Main's job because it owns
// the filesystem and the dialogs; the renderer hands over a template and gets
// back a template, and never a path it could write to (TDD §3).

export const TEMPLATE_EXTENSION = '.json';

/** One entry of a dialog's file-type list. */
export interface FileFilter {
  name: string;
  extensions: string[];
}

export interface FilePickOptions {
  title: string;
  filters: FileFilter[];
  /** Where the dialog opens, and — when saving — the name it offers. */
  defaultPath?: string;
}

/** The two system dialogs, injected: `electron` is imported in one file (TDD §3). */
export interface FileDialogs {
  /** Choose an existing file to read; `null` when cancelled. */
  openFile(options: FilePickOptions): Promise<string | null>;
  /** Choose where to write; `null` when cancelled. */
  saveFile(options: FilePickOptions): Promise<string | null>;
}

/** The slice of `node:fs` used here; injectable, so no test writes outside its temp dir. */
export interface FileServiceFs {
  readFileSync(file: string, encoding: 'utf8'): string;
  writeFileSync(file: string, data: string): void;
}

export interface FileServiceDeps {
  cards: CardSource;
  dialogs: FileDialogs;
  /** `RunService` satisfies it: the last finished run, by id. */
  runs: { result(runId: number): RunResult | null };
  fs?: FileServiceFs;
}

const TEMPLATE_FILTERS: FileFilter[] = [
  { name: 'Deck template', extensions: ['json'] },
  { name: 'All files', extensions: ['*'] },
];

/** `"a,b"`, `"say ""hi"""`: the minimal quoting every spreadsheet agrees on. */
export function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvRow(cells: readonly (string | number)[]): string {
  return cells.map(csvCell).join(',');
}

/**
 * The ranked table as CSV: one row per kept class vector, a column per line.
 *
 * **Exact fractions, never percentages.** A percentage is a rounding of the
 * answer, and two ratios a ten-thousandth of a point apart are ranked on the
 * numerator (TDD §10.3) — a spreadsheet that divides `numerator` by
 * `denominator` gets the same number the app shows, and one that sorts on
 * `numerator` gets the same order the app ranks by. Tied rows share a rank,
 * exactly as the table on screen does, because the tie is a fact about the
 * numbers and not about the display.
 *
 * `rawRatios` says how many concrete line ratios the row stands for, so a row
 * is not read as the only deck that scores it.
 */
export function resultCsv(result: RunResult): string {
  const rankOf = new Map<number, number>();
  result.ranked.forEach((vector, at) => {
    if (!rankOf.has(vector.blend.num)) rankOf.set(vector.blend.num, at + 1);
  });
  const header = [
    'rank',
    'numerator',
    'denominator',
    'rawRatios',
    ...result.lines.map((line) => line.label),
  ];
  const rows = result.ranked.map((vector, at) =>
    csvRow([
      rankOf.get(vector.blend.num) ?? at + 1,
      vector.blend.num,
      vector.blend.den,
      String(vector.rawRatios),
      ...(result.rankedRatios[at]?.example ?? result.lines.map(() => '')),
    ]),
  );
  return [csvRow(header), ...rows, ''].join('\n');
}

/** The whole result, as it left the worker, under a version of its own. */
export function resultJson(runId: number, result: RunResult): string {
  return `${JSON.stringify({ version: 1, runId, result }, null, 2)}\n`;
}

function failed(reason: 'read' | 'write', error: unknown) {
  return {
    ok: false as const,
    reason,
    message: error instanceof Error ? error.message : String(error),
  };
}

/** `Deck template.json` → `Deck template.csv`: the name a save dialog offers. */
function withExtension(name: string, extension: ExportFormat | 'json'): string {
  return `${name}.${extension}`;
}

export class FileService {
  private readonly fs: FileServiceFs;

  constructor(private readonly deps: FileServiceDeps) {
    this.fs = deps.fs ?? nodeFs;
  }

  /**
   * Read a template file the user chooses (TDD §14). The file is validated
   * here — a stored AST is what the engine judges, so it is checked before it
   * can reach `implies` — and what this install's card data says about the
   * cards the file recorded comes back as notices.
   *
   * Those notices are advice, not a fork in the road. TDD §14 also offers the
   * user a choice of the snapshot's card data over the install's; that is not
   * built. Doing it means threading an overlay index through `analyze`,
   * `resolveTemplate` and the run, and the honest half — *knowing* the numbers
   * would differ, and on which field of which card — is what makes the claim
   * checkable at all. The other half is left for its own slice.
   */
  async openTemplate(): Promise<TemplateOpenResult> {
    const ready = this.deps.cards.ready();
    if (ready === null) return this.notReady();
    const file = await this.deps.dialogs.openFile({
      title: 'Open a deck template',
      filters: TEMPLATE_FILTERS,
    });
    if (file === null) return { ok: false, reason: 'cancelled' };

    let text: string;
    try {
      text = this.fs.readFileSync(file, 'utf8');
    } catch (failure) {
      return failed('read', failure);
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (failure) {
      return {
        ok: false,
        reason: 'invalid',
        message: `${path.basename(file)} is not JSON`,
        errors: [failure instanceof Error ? failure.message : String(failure)],
      };
    }
    const validated = validateTemplate(json);
    if (!validated.ok)
      return {
        ok: false,
        reason: 'invalid',
        message: `${path.basename(file)} is not a template this build can read`,
        errors: validated.errors,
      };
    return {
      ok: true,
      template: validated.template,
      path: file,
      notices: snapshotNotices(validated.template, ready.cards),
    };
  }

  /**
   * Write the template where the user chooses, as a FILE: the authoritative
   * AST beside every text, and a snapshot of every named card (TDD §14). The
   * template arrives from the renderer, so it is validated before anything is
   * written, and written whole to a temporary name and renamed into place is
   * not needed here — a template the user saved over is one they chose to.
   */
  async saveTemplate(value: unknown): Promise<TemplateSaveResult> {
    const ready = this.deps.cards.ready();
    if (ready === null) return this.notReady();
    const validated = validateTemplate(value);
    if (!validated.ok)
      return {
        ok: false,
        reason: 'invalid',
        message: 'this is not a well-formed template',
        errors: validated.errors,
      };

    const { template, warnings } = templateToFile(validated.template, {
      cards: ready.cards,
      setnames: ready.setnames,
      groups: groupLookupOf(validated.template.groups),
    });
    const file = await this.deps.dialogs.saveFile({
      title: 'Save the deck template',
      filters: TEMPLATE_FILTERS,
      defaultPath: withExtension('template', 'json'),
    });
    if (file === null) return { ok: false, reason: 'cancelled' };
    try {
      this.fs.writeFileSync(file, `${JSON.stringify(template, null, 2)}\n`);
    } catch (failure) {
      return failed('write', failure);
    }
    return { ok: true, path: file, warnings };
  }

  /**
   * A finished run, written where the user chooses. There is no run history in
   * v1 (TDD §13), so the only exportable run is the last one to have finished;
   * asking for any other says so rather than exporting the wrong numbers.
   */
  async exportResults(request: unknown): Promise<ResultsExportResult> {
    const asked = typeof request === 'object' && request !== null ? request : {};
    const { runId, format } = asked as { runId?: unknown; format?: unknown };
    const errors: string[] = [];
    if (typeof runId !== 'number' || !Number.isInteger(runId))
      errors.push('`runId` must be a run id');
    if (format !== 'csv' && format !== 'json') errors.push('`format` must be "csv" or "json"');
    if (errors.length > 0)
      return { ok: false, reason: 'invalid', message: 'the export request is malformed', errors };

    const result = this.deps.runs.result(runId as number);
    if (result === null)
      return {
        ok: false,
        reason: 'no-run',
        message: 'that run is no longer the latest one; run again and export its result',
      };

    const file = await this.deps.dialogs.saveFile({
      title: `Export the results as ${String(format).toUpperCase()}`,
      filters: [{ name: format === 'csv' ? 'CSV' : 'JSON', extensions: [format as string] }],
      defaultPath: withExtension('results', format as ExportFormat),
    });
    if (file === null) return { ok: false, reason: 'cancelled' };
    try {
      this.fs.writeFileSync(
        file,
        format === 'csv' ? resultCsv(result) : resultJson(runId as number, result),
      );
    } catch (failure) {
      return failed('write', failure);
    }
    return { ok: true, path: file };
  }

  private notReady(): NotReady {
    const { state, error } = this.deps.cards.status();
    return {
      ok: false,
      reason: 'not-ready',
      state,
      message:
        state === 'loading'
          ? 'the card data is still loading'
          : state === 'error'
            ? `the card data failed to load: ${error ?? 'unknown error'}`
            : 'no EDOPro folder is set, so a template cannot be read against one',
    };
  }
}

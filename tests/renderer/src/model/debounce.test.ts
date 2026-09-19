import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ANALYZE_DEBOUNCE_MS, Debouncer } from '../../../../src/renderer/src/model/debounce';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ANALYZE_DEBOUNCE_MS', () => {
  it('is the ~150 ms the analysis is held back by (TDD §12)', () => {
    expect(ANALYZE_DEBOUNCE_MS).toBe(150);
  });
});

describe('Debouncer', () => {
  describe('schedule', () => {
    it('does not run the task straight away', () => {
      const task = vi.fn();
      new Debouncer(150).schedule(task);
      expect(task).not.toHaveBeenCalled();
    });

    it('runs it once the delay is up', () => {
      const task = vi.fn();
      new Debouncer(150).schedule(task);
      vi.advanceTimersByTime(150);
      expect(task).toHaveBeenCalledTimes(1);
    });

    it('is still waiting one tick short of the delay', () => {
      const task = vi.fn();
      new Debouncer(150).schedule(task);
      vi.advanceTimersByTime(149);
      expect(task).not.toHaveBeenCalled();
    });

    it('runs ONCE for a burst of keystrokes, not once per keystroke', () => {
      const task = vi.fn();
      const debouncer = new Debouncer(150);
      for (let i = 0; i < 10; i++) {
        debouncer.schedule(task);
        vi.advanceTimersByTime(20);
      }
      expect(task).not.toHaveBeenCalled();
      vi.advanceTimersByTime(150);
      expect(task).toHaveBeenCalledTimes(1);
    });

    it('runs the newest task of a burst, not the one the burst began with', () => {
      const debouncer = new Debouncer(150);
      const first = vi.fn();
      const last = vi.fn();
      debouncer.schedule(first);
      debouncer.schedule(last);
      vi.advanceTimersByTime(150);
      expect(first).not.toHaveBeenCalled();
      expect(last).toHaveBeenCalledTimes(1);
    });

    it('runs again for an edit that comes after a quiet spell', () => {
      const task = vi.fn();
      const debouncer = new Debouncer(150);
      debouncer.schedule(task);
      vi.advanceTimersByTime(150);
      debouncer.schedule(task);
      vi.advanceTimersByTime(150);
      expect(task).toHaveBeenCalledTimes(2);
    });
  });

  describe('cancel', () => {
    it('drops a task still waiting — what unmounting does', () => {
      const task = vi.fn();
      const debouncer = new Debouncer(150);
      debouncer.schedule(task);
      debouncer.cancel();
      vi.advanceTimersByTime(1000);
      expect(task).not.toHaveBeenCalled();
    });

    it('is harmless with nothing waiting', () => {
      expect(() => new Debouncer(150).cancel()).not.toThrow();
    });
  });

  describe('run', () => {
    it('runs a waiting task at once and clears it', () => {
      const task = vi.fn();
      const debouncer = new Debouncer(150);
      debouncer.schedule(task);
      debouncer.run();
      expect(task).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1000);
      expect(task).toHaveBeenCalledTimes(1);
    });

    it('does nothing with nothing waiting', () => {
      expect(() => new Debouncer(150).run()).not.toThrow();
    });
  });
});

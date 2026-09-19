import { chooseFolder } from '../model/choose-folder';
import { setupFailure } from '../model/setup';
import { selectStage, useApp } from '../store';
import { ProbeReadout } from './probe-readout';

// First-run setup (PRD §8.1). Shown in place of the workspace while there is
// no card index: the app cannot do anything without one, and saying so once,
// plainly, beats an empty editor with everything disabled.

function useChoose(): () => void {
  const setProbe = useApp((state) => state.setProbe);
  return () => {
    void chooseFolder(window.api).then((outcome) => {
      // Cancelled: nothing was probed, so nothing to report. Saved: main is
      // already loading, and the status bar takes over from here.
      if (outcome.kind !== 'cancelled') setProbe(outcome.health);
    });
  };
}

export function SetupView() {
  const stage = useApp(selectStage);
  const status = useApp((state) => state.cards);
  const probe = useApp((state) => state.probe);
  const choose = useChoose();

  if (stage === 'loading')
    return (
      <section className="panel setup" data-testid="setup-loading">
        <h2>Loading cards</h2>
        <div className="actions spaced">
          {/* Appears only if a load ever runs long: 112 ms is the measured cold
              time on a real install (TDD §13), and a flash of spinner is worse
              than none. Nothing here pretends to know how far along it is. */}
          <span className="spinner" />
          <p className="hint flush">
            Reading the card databases in {status?.workdir ?? 'the EDOPro folder'}.
          </p>
        </div>
      </section>
    );

  if (stage === 'error' && status !== null)
    return (
      <section className="panel setup" data-testid="setup-error">
        <h2>The cards could not be loaded</h2>
        {setupFailure(status).map((line) => (
          <p key={line}>{line}</p>
        ))}
        <div className="actions spaced">
          <button type="button" className="primary" onClick={() => void window.api.reindexCards()}>
            Try again
          </button>
          <button type="button" onClick={choose}>
            Choose EDOPro folder…
          </button>
        </div>
        {probe !== null && <ProbeReadout health={probe} />}
      </section>
    );

  return (
    <section className="panel setup" data-testid="setup-choose">
      <h2>Point the app at your EDOPro folder</h2>
      <p>
        This tool works out deck ratios from real card data, and it reads that data from your own
        install of <strong>EDOPro</strong> (Project Ignis) — the free Yu-Gi-Oh! simulator. It needs
        the folder that install lives in.
      </p>
      <p>
        Only the card databases (<code>cards.cdb</code> and its expansions) and the archetype names
        in <code>strings.conf</code> are read, and only for reading. Nothing is written to that
        folder, and <strong>nothing is uploaded anywhere</strong>: the app makes no network requests
        at all.
      </p>
      <p className="hint">
        The usual places were checked first — <code>~/ProjectIgnis</code>,{' '}
        <code>~/Applications/ProjectIgnis</code>, <code>/Applications/ProjectIgnis</code> on macOS,{' '}
        <code>C:\ProjectIgnis</code> and <code>C:\Games\ProjectIgnis</code> on Windows — and no
        install turned up there.
      </p>
      <div className="actions spaced">
        <button type="button" className="primary" onClick={choose}>
          Choose EDOPro folder…
        </button>
      </div>
      {probe !== null && <ProbeReadout health={probe} />}
    </section>
  );
}

import { useState } from 'react';
import type { SettingsPatch } from '../../../shared/types';
import { statusRows } from '../model/card-status';
import { chooseFolder } from '../model/choose-folder';
import { deltaFromPoints, deltaToPoints, settingsPatch } from '../model/settings-form';
import { useApp } from '../store';
import { ProbeReadout } from './probe-readout';

// The settings panel (TDD §13): the folder, the population, the plateau's
// width, and what the last load found.

export function SettingsView() {
  const settings = useApp((state) => state.settings);
  const status = useApp((state) => state.cards);
  const probe = useApp((state) => state.probe);
  const store = useApp((state) => state.setSettings);
  const setProbe = useApp((state) => state.setProbe);
  const show = useApp((state) => state.show);
  // The field keeps what is typed, which may not be a width yet.
  const [points, setPoints] = useState<string | null>(null);

  function save(patch: SettingsPatch): void {
    if (settings === null) return;
    const changed = settingsPatch(settings, patch);
    // Nothing changed: a workdir or pre-release patch would reload the cards.
    if (Object.keys(changed).length === 0) return;
    void window.api.setSettings(changed).then(store);
  }

  function choose(): void {
    void chooseFolder(window.api).then((outcome) => {
      if (outcome.kind === 'cancelled') return;
      setProbe(outcome.health);
      if (outcome.kind === 'saved') void window.api.getSettings().then(store);
    });
  }

  if (settings === null)
    return (
      <section className="panel setup wide" data-testid="settings">
        <h2>Settings</h2>
        <p className="hint">Reading the settings file…</p>
      </section>
    );

  const typed = points ?? deltaToPoints(settings.plateauDelta);
  const width = deltaFromPoints(typed);

  return (
    <section className="panel setup wide" data-testid="settings">
      <h2>Settings</h2>

      <h3>EDOPro install</h3>
      <p className="hint">
        Where the card databases and archetype names are read from. Changing it reloads the cards.
      </p>
      <div className="row">
        <label htmlFor="workdir">Folder</label>
        <input
          type="text"
          id="workdir"
          value={settings.workdir ?? ''}
          placeholder="not set"
          readOnly
        />
        <button type="button" onClick={choose}>
          Choose…
        </button>
      </div>
      {probe !== null && <ProbeReadout health={probe} />}

      <h3>Card population</h3>
      <div className="row">
        <label htmlFor="prerelease">Pre-release cards</label>
        <label className="check">
          <input
            type="checkbox"
            id="prerelease"
            checked={settings.includePrerelease}
            onChange={(event) => save({ includePrerelease: event.target.checked })}
          />
          Include official pre-release cards
        </label>
      </div>
      <p className="field-note">
        EDOPro's own definition of "official" is OCG, TCG and pre-release; anime, Rush and custom
        cards are never included. Changing this reloads the cards.
      </p>

      <h3>Optimizer</h3>
      <div className="row">
        <label htmlFor="plateau">Plateau width</label>
        <input
          type="text"
          className="narrow"
          id="plateau"
          value={typed}
          inputMode="decimal"
          aria-describedby="plateau-note"
          aria-invalid={width === null}
          onChange={(event) => setPoints(event.target.value)}
          onBlur={() => {
            if (width !== null) save({ plateauDelta: width });
            setPoints(null);
          }}
        />
        <span className="after">percentage points</span>
      </div>
      <p className={width === null ? 'field-note bad' : 'field-note'} id="plateau-note">
        {width === null
          ? 'A width between 0 and 100 percentage points.'
          : `Ratios within ${typed} of the best are reported as the plateau — the near-optimal ratios that are, for practical purposes, as good.`}
      </p>

      <h3>What the last load found</h3>
      {status === null ? (
        <p className="hint">The card status has not arrived yet.</p>
      ) : (
        <table className="rows">
          <tbody>
            {statusRows(status).map(([label, value]) => (
              <tr key={label}>
                <th>{label}</th>
                <td>{value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="actions spaced">
        <button type="button" className="primary" onClick={() => show('workspace')}>
          Done
        </button>
      </div>
    </section>
  );
}

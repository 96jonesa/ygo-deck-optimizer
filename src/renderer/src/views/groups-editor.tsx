import { useState } from 'react';
import type { CardHit, TemplateGroup } from '../../../shared/types';
import { groupAnalysisOf } from '../model/analysis-view';
import { selectAnalysis, selectCardState, useApp } from '../store';
import { CardPicker } from './card-picker';
import { useField } from './fields';
import { IssueList } from './line-row';

// User-defined groups (PRD §5.2): a name and a set of cards, usable in any
// description as `{name}`. The picker above the chips is the one M2c built,
// with `value={null}` and a list the caller keeps — which is what its
// single-select shape was designed to compose into.

function GroupRow({ group }: { group: TemplateGroup }) {
  const known = useApp((state) => state.known);
  const cardState = useApp(selectCardState);
  const analysis = useApp(selectAnalysis);
  const renameGroup = useApp((state) => state.renameGroup);
  const dropGroup = useApp((state) => state.dropGroup);
  const addGroupCard = useApp((state) => state.addGroupCard);
  const dropGroupCard = useApp((state) => state.dropGroupCard);
  const [name, setName] = useField(group.name);
  const found = groupAnalysisOf(analysis, group.id);

  return (
    <li className="group" data-testid={`group-${group.id}`}>
      <div className="group-main">
        <span className="line-id">{'{ }'}</span>
        <input
          type="text"
          className="desc"
          value={name}
          aria-label={`Name of group ${group.id}`}
          data-testid={`group-name-${group.id}`}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => {
            setName(event.target.value);
            renameGroup(group.id, event.target.value);
          }}
        />
        <span className="dim tabular">
          {group.cards.length} card{group.cards.length === 1 ? '' : 's'}
        </span>
        <span className="line-buttons">
          <button
            type="button"
            className="quiet icon"
            aria-label={`Delete group ${group.name}`}
            onClick={() => dropGroup(group.id)}
          >
            {'×'}
          </button>
        </span>
      </div>
      <div className="group-body">
        <CardPicker
          id={`group-pick-${group.id}`}
          label={`Add a card to ${group.name}`}
          value={null}
          cardState={cardState}
          placeholder={`Add a card to {${group.name}}…`}
          onPick={(card) => {
            if (card !== null) addGroupCard(group.id, card);
          }}
        />
        {group.cards.length > 0 && (
          <ul className="chips" data-testid={`group-cards-${group.id}`}>
            {group.cards.map((member) => {
              const hit: CardHit = known[member.passcode] ?? {
                passcode: member.passcode,
                name: member.name,
                typeline: `#${member.passcode}`,
              };
              return (
                <li key={member.passcode}>
                  <span className="card-chip">
                    <span className="name">{hit.name}</span>
                    <span className="typeline">{hit.typeline}</span>
                    <button
                      type="button"
                      aria-label={`Remove ${hit.name} from ${group.name}`}
                      onClick={() => dropGroupCard(group.id, member.passcode)}
                    >
                      ×
                    </button>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        <IssueList issues={found?.issues ?? []} />
      </div>
    </li>
  );
}

export function GroupsEditor() {
  const groups = useApp((state) => state.template.groups);
  const addGroup = useApp((state) => state.addGroup);
  const [draft, setDraft] = useState('');

  function create(): void {
    addGroup(draft);
    setDraft('');
  }

  return (
    <>
      <h3>Groups</h3>
      <p className="hint flush">
        A group is a set of cards under a name of your own — <code>starter</code>,{' '}
        <code>brick</code> — usable in any description as <code>{'{starter}'}</code>. It is the one
        thing the card database cannot tell you.
      </p>
      {groups.length > 0 && (
        <ul className="groups" data-testid="groups">
          {groups.map((group) => (
            <GroupRow key={group.id} group={group} />
          ))}
        </ul>
      )}
      <div className="actions spaced">
        <input
          type="text"
          className="narrow-name"
          value={draft}
          aria-label="Name for a new group"
          data-testid="new-group"
          placeholder="starter"
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') create();
          }}
        />
        <button type="button" disabled={draft.trim() === ''} onClick={create}>
          New group
        </button>
      </div>
    </>
  );
}

/**
 * VaultPanel — self-contained side-panel UI for the encrypted profile vault.
 *
 * Renders a passphrase gate (create / unlock) and, once unlocked, a compact,
 * scrollable editor for the whole profile. Sensitive fields (govIds / PAN /
 * bank) sit behind an explicit reveal confirmation and are never shown by
 * default. Wire it up with `<VaultPanel onClose={() => …} />`.
 *
 * Shell contract (shared with RemindersPanel / PagePanel): a
 * `flex h-full min-h-0 flex-1 flex-col` root, a compact header row with a title
 * badge + ghost ✕ close, and one `flex-1 min-h-0 overflow-y-auto` scroll region,
 * so it drops straight into the ~400px side panel below App.tsx's tab bar.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  cn,
  SketchBadge,
  SketchButton,
  SketchCard,
  SketchInput,
  SketchToggle,
  ThinkingDots,
  type AccentName,
} from '@diggy/ui';
import type {
  CustomAnswer,
  Education,
  Experience,
  Identity,
  LinkSet,
  Preferences,
  Profile,
  Secrets,
} from '@diggy/shared';
import {
  createVault,
  getSecrets,
  getVaultProfile,
  lockVault,
  onVaultChange,
  saveVaultProfile,
  unlockVault,
  vaultStatus,
  type VaultStatus,
} from '../../src/vault-store';

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

interface KeyValueRow {
  key: string;
  value: string;
}

interface ListDrafts {
  skills: string;
  roles: string;
  locations: string;
}

function parseList(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function recordToRows(record: Record<string, string> | undefined): KeyValueRow[] {
  if (!record) return [];
  return Object.entries(record).map(([key, value]) => ({ key, value }));
}

function rowsToRecord(rows: KeyValueRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (key.length > 0) out[key] = row.value;
  }
  return out;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'OperationError' || /operation-specific|decrypt|authentic/i.test(error.message)) {
      return 'Incorrect passphrase — please try again.';
    }
    return error.message;
  }
  return String(error);
}

/* ------------------------------------------------------------------ *
 * Presentational helpers
 * ------------------------------------------------------------------ */

function SectionTitle({ label, accent }: { label: string; accent: AccentName }): JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <SketchBadge accent={accent} size="sm" dot>
        {label}
      </SketchBadge>
    </div>
  );
}

/** Friendly, specific empty state for a list section inside the vault. */
function EmptyState({ icon, text }: { icon: string; text: string }): JSX.Element {
  return (
    <div className="flex items-start gap-2 rounded-sketch-sm border-2 border-dashed border-ink/20 bg-paper-100/50 px-2.5 py-2">
      <span aria-hidden="true" className="text-sm leading-5">
        {icon}
      </span>
      <p className="min-w-0 font-sketch text-xs leading-snug text-ink-500">{text}</p>
    </div>
  );
}

interface FieldProps {
  label: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  type?: string;
  autoFocus?: boolean;
  autoComplete?: string;
  /** Extra classes for the field wrapper (e.g. `flex-1 min-w-0` in a row). */
  containerClassName?: string;
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  type,
  autoFocus,
  autoComplete,
  containerClassName,
}: FieldProps): JSX.Element {
  return (
    <SketchInput
      label={label}
      value={value}
      type={type}
      autoFocus={autoFocus}
      placeholder={placeholder}
      autoComplete={autoComplete}
      containerClassName={cn('min-w-0', containerClassName)}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

/** Native textarea styled to match `SketchInput`. */
function TextArea({
  label,
  value,
  onChange,
  rows = 2,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  rows?: number;
}): JSX.Element {
  return (
    <label className="flex w-full min-w-0 flex-col gap-1.5">
      <span className="font-sketch text-sm font-semibold text-ink-700">{label}</span>
      <textarea
        rows={rows}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-sketch-sm border-2 border-ink/20 bg-paper-100/60 px-3 py-2 font-sketch text-sm text-ink outline-none transition-colors focus:border-ink/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dashed focus-visible:outline-ink/70"
      />
    </label>
  );
}

const WORK_TYPES: { value: NonNullable<Preferences['workType']>; label: string }[] = [
  { value: 'remote', label: 'Remote' },
  { value: 'hybrid', label: 'Hybrid' },
  { value: 'onsite', label: 'Onsite' },
  { value: 'any', label: 'Any' },
];

/* ------------------------------------------------------------------ *
 * Panel
 * ------------------------------------------------------------------ */

export function VaultPanel({ onClose }: { onClose: () => void }): JSX.Element {
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState<VaultStatus>('locked');
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState('');

  const [profile, setProfile] = useState<Profile | null>(null);
  const [lists, setLists] = useState<ListDrafts>({ skills: '', roles: '', locations: '' });

  // Sensitive section — only populated after an explicit reveal.
  const [showSecrets, setShowSecrets] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [secretsLoaded, setSecretsLoaded] = useState(false);
  const [govIdRows, setGovIdRows] = useState<KeyValueRow[]>([]);
  const [bankRows, setBankRows] = useState<KeyValueRow[]>([]);
  const [pan, setPan] = useState('');

  /* --- lifecycle ---------------------------------------------------- */

  const hydrateFromVault = useCallback(async () => {
    const loaded = await getVaultProfile();
    if (!loaded) return null;
    setProfile(loaded);
    setLists({
      skills: loaded.skills.join(', '),
      roles: (loaded.preferences.roles ?? []).join(', '),
      locations: (loaded.preferences.locations ?? []).join(', '),
    });
    return loaded;
  }, []);

  useEffect(() => {
    let active = true;
    void (async () => {
      const next = await vaultStatus();
      if (!active) return;
      setStatus(next);
      if (next === 'unlocked') await hydrateFromVault();
      setReady(true);
    })();

    const off = onVaultChange((next) => {
      setStatus(next);
      if (next !== 'unlocked') setProfile(null);
    });

    return () => {
      active = false;
      off();
    };
  }, [hydrateFromVault]);

  /* --- profile mutations -------------------------------------------- */

  const updateIdentity = useCallback((patch: Partial<Identity>) => {
    setProfile((current) =>
      current ? { ...current, identity: { ...current.identity, ...patch } } : current,
    );
  }, []);

  const updateLinks = useCallback((patch: Partial<LinkSet>) => {
    setProfile((current) =>
      current
        ? { ...current, identity: { ...current.identity, links: { ...current.identity.links, ...patch } } }
        : current,
    );
  }, []);

  const updatePrefs = useCallback((patch: Partial<Preferences>) => {
    setProfile((current) =>
      current ? { ...current, preferences: { ...current.preferences, ...patch } } : current,
    );
  }, []);

  const addEducation = useCallback(() => {
    setProfile((current) => (current ? { ...current, education: [...current.education, { institution: '' }] } : current));
  }, []);
  const updateEducation = useCallback((index: number, patch: Partial<Education>) => {
    setProfile((current) =>
      current
        ? { ...current, education: current.education.map((item, i) => (i === index ? { ...item, ...patch } : item)) }
        : current,
    );
  }, []);
  const removeEducation = useCallback((index: number) => {
    setProfile((current) =>
      current ? { ...current, education: current.education.filter((_, i) => i !== index) } : current,
    );
  }, []);

  const addExperience = useCallback(() => {
    setProfile((current) => (current ? { ...current, experience: [...current.experience, { company: '' }] } : current));
  }, []);
  const updateExperience = useCallback((index: number, patch: Partial<Experience>) => {
    setProfile((current) =>
      current
        ? { ...current, experience: current.experience.map((item, i) => (i === index ? { ...item, ...patch } : item)) }
        : current,
    );
  }, []);
  const removeExperience = useCallback((index: number) => {
    setProfile((current) =>
      current ? { ...current, experience: current.experience.filter((_, i) => i !== index) } : current,
    );
  }, []);

  const addAnswer = useCallback(() => {
    setProfile((current) =>
      current ? { ...current, customAnswers: [...current.customAnswers, { pattern: '', answer: '' }] } : current,
    );
  }, []);
  const updateAnswer = useCallback((index: number, patch: Partial<CustomAnswer>) => {
    setProfile((current) =>
      current
        ? { ...current, customAnswers: current.customAnswers.map((item, i) => (i === index ? { ...item, ...patch } : item)) }
        : current,
    );
  }, []);
  const removeAnswer = useCallback((index: number) => {
    setProfile((current) =>
      current ? { ...current, customAnswers: current.customAnswers.filter((_, i) => i !== index) } : current,
    );
  }, []);

  const updateGovIdRow = useCallback((index: number, patch: Partial<KeyValueRow>) => {
    setGovIdRows((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }, []);
  const updateBankRow = useCallback((index: number, patch: Partial<KeyValueRow>) => {
    setBankRows((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }, []);

  /* --- actions ------------------------------------------------------ */

  const handleSubmit = useCallback(async () => {
    if (busy) return;
    const pass = passphrase;
    if (pass.length === 0) {
      setError('Enter a passphrase first.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      if (status === 'new') await createVault(pass);
      else await unlockVault(pass);
      await hydrateFromVault();
      setPassphrase('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [busy, passphrase, status, hydrateFromVault]);

  const handleSave = useCallback(async () => {
    if (!profile || busy) return;
    setBusy(true);
    setError('');
    try {
      const secrets: Secrets = secretsLoaded
        ? { govIds: rowsToRecord(govIdRows), pan: pan.trim() || undefined, bank: rowsToRecord(bankRows) }
        : await getSecrets(true);
      const next: Profile = {
        ...profile,
        skills: parseList(lists.skills),
        preferences: {
          ...profile.preferences,
          roles: parseList(lists.roles),
          locations: parseList(lists.locations),
        },
        secrets,
      };
      await saveVaultProfile(next);
      setProfile({ ...next, secrets: {} });
      setSavedAt(new Date().toLocaleTimeString());
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [profile, busy, secretsLoaded, govIdRows, bankRows, pan, lists]);

  const handleLock = useCallback(async () => {
    setBusy(true);
    try {
      await lockVault();
    } finally {
      setProfile(null);
      setRevealed(false);
      setSecretsLoaded(false);
      setShowSecrets(false);
      setBusy(false);
    }
  }, []);

  const handleReveal = useCallback(async () => {
    setError('');
    try {
      const secrets = await getSecrets(true);
      setGovIdRows(recordToRows(secrets.govIds));
      setBankRows(recordToRows(secrets.bank));
      setPan(secrets.pan ?? '');
      setSecretsLoaded(true);
      setRevealed(true);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  const hideSecrets = useCallback(() => {
    // Keep the loaded drafts so a later save doesn't wipe them; just stop showing.
    setRevealed(false);
  }, []);

  /* --- render: locked / new ----------------------------------------- */

  const lockScreen = (
    <SketchCard tone="accent" accent="violet" className="space-y-3">
      <div className="space-y-1">
        <p className="font-sketch text-sm font-semibold text-ink-700">
          {status === 'new' ? 'Create your encrypted vault' : 'Unlock your vault'}
        </p>
        <p className="font-sketch text-xs leading-snug text-ink-500">
          {status === 'new'
            ? 'Your profile is empty for now — add your name, a role and a degree, and Diggy can fill job forms from it.'
            : 'Welcome back — unlock to edit your details, skills and links.'}
        </p>
      </div>
      <SketchInput
        label="Passphrase"
        type="password"
        value={passphrase}
        autoFocus
        placeholder="••••••••"
        autoComplete={status === 'new' ? 'new-password' : 'current-password'}
        error={error || undefined}
        onChange={(event) => setPassphrase(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') void handleSubmit();
        }}
      />
      <p className="text-[11px] leading-snug text-ink-500">
        Your profile is encrypted locally with AES-256-GCM (Argon2id key derivation). It never leaves this
        browser — nothing is uploaded to any server.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <SketchButton variant="accent" accent="violet" loading={busy} onClick={() => void handleSubmit()}>
          {status === 'new' ? 'Create vault' : 'Unlock'}
        </SketchButton>
        <SketchButton variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </SketchButton>
      </div>
    </SketchCard>
  );

  /* --- render: unlocked --------------------------------------------- */

  const editor = profile ? (
    <>
      <div className="flex items-center justify-between gap-2">
        <p
          className="min-w-0 truncate font-sketch text-xs text-ink-500"
          title={savedAt ? `Saved at ${savedAt}` : undefined}
        >
          {savedAt ? `Saved ${savedAt}` : 'Edit your details, then save.'}
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <SketchButton size="sm" variant="accent" accent="green" loading={busy} onClick={() => void handleSave()}>
            Save
          </SketchButton>
          <SketchButton size="sm" variant="paper" accent="amber" onClick={() => void handleLock()}>
            Lock
          </SketchButton>
        </div>
      </div>
      {error ? (
        <p role="alert" className="break-words font-sketch text-sm text-crayon-red-deep">
          {error}
        </p>
      ) : null}

      {/* Identity ------------------------------------------------------ */}
      <SketchCard tone="paper" className="space-y-3">
        <SectionTitle accent="sky" label="Identity" />
        <Field label="Full name" value={profile.identity.fullName} onChange={(value) => updateIdentity({ fullName: value })} />
        <div className="grid grid-cols-2 gap-2">
          <Field label="First name" value={profile.identity.firstName ?? ''} onChange={(value) => updateIdentity({ firstName: value })} />
          <Field label="Last name" value={profile.identity.lastName ?? ''} onChange={(value) => updateIdentity({ lastName: value })} />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Email" type="email" value={profile.identity.email ?? ''} onChange={(value) => updateIdentity({ email: value })} />
          <Field label="Phone" value={profile.identity.phone ?? ''} onChange={(value) => updateIdentity({ phone: value })} />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Date of birth" value={profile.identity.dob ?? ''} onChange={(value) => updateIdentity({ dob: value })} />
          <Field label="Gender" value={profile.identity.gender ?? ''} onChange={(value) => updateIdentity({ gender: value })} />
        </div>
        <Field label="Address" value={profile.identity.address ?? ''} onChange={(value) => updateIdentity({ address: value })} />
        <div className="grid grid-cols-2 gap-2">
          <Field label="City" value={profile.identity.city ?? ''} onChange={(value) => updateIdentity({ city: value })} />
          <Field label="State" value={profile.identity.state ?? ''} onChange={(value) => updateIdentity({ state: value })} />
          <Field label="Country" value={profile.identity.country ?? ''} onChange={(value) => updateIdentity({ country: value })} />
          <Field label="Postal code" value={profile.identity.postalCode ?? ''} onChange={(value) => updateIdentity({ postalCode: value })} />
        </div>
      </SketchCard>

      {/* Links --------------------------------------------------------- */}
      <SketchCard tone="paper" className="space-y-3">
        <SectionTitle accent="teal" label="Links" />
        <Field label="GitHub" value={profile.identity.links.github ?? ''} onChange={(value) => updateLinks({ github: value })} />
        <Field label="LinkedIn" value={profile.identity.links.linkedin ?? ''} onChange={(value) => updateLinks({ linkedin: value })} />
        <Field label="Portfolio" value={profile.identity.links.portfolio ?? ''} onChange={(value) => updateLinks({ portfolio: value })} />
        <Field label="LeetCode" value={profile.identity.links.leetcode ?? ''} onChange={(value) => updateLinks({ leetcode: value })} />
      </SketchCard>

      {/* Skills -------------------------------------------------------- */}
      <SketchCard tone="paper" className="space-y-3">
        <SectionTitle accent="lime" label="Skills" />
        <Field
          label="Skills (comma separated)"
          value={lists.skills}
          placeholder="React, TypeScript, Node.js"
          onChange={(value) => setLists((current) => ({ ...current, skills: value }))}
        />
      </SketchCard>

      {/* Education ----------------------------------------------------- */}
      <SketchCard tone="paper" className="space-y-3">
        <div className="flex items-center justify-between">
          <SectionTitle accent="amber" label="Education" />
          <SketchButton size="sm" variant="ghost" aria-label="Add education entry" className="shrink-0" onClick={addEducation}>
            ＋ Add
          </SketchButton>
        </div>
        {profile.education.length === 0 ? (
          <EmptyState
            icon="🎓"
            text="No education yet — add a degree or course and Diggy can fill those fields for you."
          />
        ) : null}
        {profile.education.map((entry, index) => (
          <div key={index} className="space-y-2 rounded-sketch-sm border-2 border-dashed border-ink/25 p-2">
            <div className="flex items-center justify-between">
              <span className="font-sketch text-xs text-ink-500">#{index + 1}</span>
              <SketchButton
                size="sm"
                variant="ghost"
                accent="red"
                aria-label={`Remove education entry ${index + 1}`}
                className="shrink-0"
                onClick={() => removeEducation(index)}
              >
                Remove
              </SketchButton>
            </div>
            <Field label="Institution" value={entry.institution} onChange={(value) => updateEducation(index, { institution: value })} />
            <div className="grid grid-cols-2 gap-2">
              <Field label="Degree" value={entry.degree ?? ''} onChange={(value) => updateEducation(index, { degree: value })} />
              <Field label="Field" value={entry.field ?? ''} onChange={(value) => updateEducation(index, { field: value })} />
              <Field label="Start year" value={entry.startYear ?? ''} onChange={(value) => updateEducation(index, { startYear: value })} />
              <Field label="End year" value={entry.endYear ?? ''} onChange={(value) => updateEducation(index, { endYear: value })} />
              <Field label="Grade" value={entry.grade ?? ''} onChange={(value) => updateEducation(index, { grade: value })} />
            </div>
          </div>
        ))}
      </SketchCard>

      {/* Experience ---------------------------------------------------- */}
      <SketchCard tone="paper" className="space-y-3">
        <div className="flex items-center justify-between">
          <SectionTitle accent="orange" label="Experience" />
          <SketchButton size="sm" variant="ghost" aria-label="Add experience entry" className="shrink-0" onClick={addExperience}>
            ＋ Add
          </SketchButton>
        </div>
        {profile.experience.length === 0 ? (
          <EmptyState
            icon="💼"
            text="No roles yet — add your work history and job forms start filling themselves."
          />
        ) : null}
        {profile.experience.map((entry, index) => (
          <div key={index} className="space-y-2 rounded-sketch-sm border-2 border-dashed border-ink/25 p-2">
            <div className="flex items-center justify-between">
              <span className="font-sketch text-xs text-ink-500">#{index + 1}</span>
              <SketchButton
                size="sm"
                variant="ghost"
                accent="red"
                aria-label={`Remove experience entry ${index + 1}`}
                className="shrink-0"
                onClick={() => removeExperience(index)}
              >
                Remove
              </SketchButton>
            </div>
            <Field label="Company" value={entry.company} onChange={(value) => updateExperience(index, { company: value })} />
            <div className="grid grid-cols-2 gap-2">
              <Field label="Role" value={entry.role ?? ''} onChange={(value) => updateExperience(index, { role: value })} />
              <Field label="Location" value={entry.location ?? ''} onChange={(value) => updateExperience(index, { location: value })} />
              <Field label="Start date" value={entry.startDate ?? ''} onChange={(value) => updateExperience(index, { startDate: value })} />
              <Field label="End date" value={entry.endDate ?? ''} onChange={(value) => updateExperience(index, { endDate: value })} />
            </div>
            <SketchToggle
              label="Current role"
              checked={Boolean(entry.current)}
              onCheckedChange={(checked) => updateExperience(index, { current: checked })}
            />
            <TextArea label="Description" value={entry.description ?? ''} onChange={(value) => updateExperience(index, { description: value })} />
          </div>
        ))}
      </SketchCard>

      {/* Preferences --------------------------------------------------- */}
      <SketchCard tone="paper" className="space-y-3">
        <SectionTitle accent="indigo" label="Preferences" />
        <Field
          label="Roles (comma separated)"
          value={lists.roles}
          placeholder="Frontend Engineer, SDE"
          onChange={(value) => setLists((current) => ({ ...current, roles: value }))}
        />
        <Field
          label="Locations (comma separated)"
          value={lists.locations}
          placeholder="Bengaluru, Remote"
          onChange={(value) => setLists((current) => ({ ...current, locations: value }))}
        />
        <div className="grid grid-cols-2 gap-2">
          <label className="flex min-w-0 flex-col gap-1.5">
            <span className="font-sketch text-sm font-semibold text-ink-700">Work type</span>
            <select
              value={profile.preferences.workType ?? ''}
              onChange={(event) =>
                updatePrefs({ workType: (event.target.value || undefined) as Preferences['workType'] })
              }
              className="w-full rounded-sketch-sm border-2 border-ink/20 bg-paper-100/60 px-3 py-2 font-sketch text-sm text-ink outline-none transition-colors focus:border-ink/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dashed focus-visible:outline-ink/70"
            >
              <option value="">Unset</option>
              {WORK_TYPES.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <Field
            label="Notice period"
            value={profile.preferences.noticePeriod ?? ''}
            onChange={(value) => updatePrefs({ noticePeriod: value })}
          />
        </div>
        <Field
          label="Expected CTC"
          value={profile.preferences.expectedCtc ?? ''}
          onChange={(value) => updatePrefs({ expectedCtc: value })}
        />
      </SketchCard>

      {/* Custom answers ------------------------------------------------ */}
      <SketchCard tone="paper" className="space-y-3">
        <div className="flex items-center justify-between">
          <SectionTitle accent="pink" label="Custom answers" />
          <SketchButton size="sm" variant="ghost" aria-label="Add custom answer" className="shrink-0" onClick={addAnswer}>
            ＋ Add
          </SketchButton>
        </div>
        {profile.customAnswers.length === 0 ? (
          <EmptyState
            icon="💬"
            text="No saved answers yet — teach Diggy how you reply to the questions that keep coming up."
          />
        ) : null}
        {profile.customAnswers.map((entry, index) => (
          <div key={index} className="space-y-2 rounded-sketch-sm border-2 border-dashed border-ink/25 p-2">
            <div className="flex items-center justify-between">
              <span className="font-sketch text-xs text-ink-500">#{index + 1}</span>
              <SketchButton
                size="sm"
                variant="ghost"
                accent="red"
                aria-label={`Remove custom answer ${index + 1}`}
                className="shrink-0"
                onClick={() => removeAnswer(index)}
              >
                Remove
              </SketchButton>
            </div>
            <Field label="Question / pattern" value={entry.pattern} onChange={(value) => updateAnswer(index, { pattern: value })} />
            <TextArea label="Answer" value={entry.answer} onChange={(value) => updateAnswer(index, { answer: value })} />
          </div>
        ))}
      </SketchCard>

      {/* Sensitive ----------------------------------------------------- */}
      <SketchCard tone="muted" className="space-y-2">
        <button
          type="button"
          aria-expanded={showSecrets}
          className="flex w-full items-center justify-between gap-2 rounded-sketch-sm px-1 py-0.5 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dashed focus-visible:outline-ink/70"
          onClick={() => setShowSecrets((value) => !value)}
        >
          <span className="flex min-w-0 items-center gap-2">
            <SketchBadge accent="red" size="sm" dot>
              Sensitive
            </SketchBadge>
            <span className="truncate font-sketch text-sm font-semibold text-ink-700">
              Gov IDs · PAN · Bank
            </span>
          </span>
          <span aria-hidden="true" className="shrink-0 text-ink-500">
            {showSecrets ? '▾' : '▸'}
          </span>
        </button>

        {showSecrets ? (
          !revealed ? (
            <div className="space-y-2">
              <p className="text-[11px] leading-snug text-ink-500">
                These values stay encrypted and hidden by default, and are never auto-filled. Reveal only when you
                need to review or edit them.
              </p>
              <SketchButton size="sm" variant="accent" accent="red" onClick={() => void handleReveal()}>
                Reveal secrets
              </SketchButton>
            </div>
          ) : (
            <div className="space-y-3">
              <Field label="PAN" value={pan} onChange={setPan} />

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-sketch text-xs font-semibold uppercase tracking-wide text-ink-500">Gov IDs</span>
                  <SketchButton
                    size="sm"
                    variant="ghost"
                    aria-label="Add government ID"
                    className="shrink-0"
                    onClick={() => setGovIdRows((rows) => [...rows, { key: '', value: '' }])}
                  >
                    ＋ Add
                  </SketchButton>
                </div>
                {govIdRows.length === 0 ? (
                  <EmptyState
                    icon="🪪"
                    text="Nothing saved — add an ID only if a form actually asks for it."
                  />
                ) : null}
                {govIdRows.map((row, index) => (
                  <div key={index} className="flex items-end gap-2">
                    <Field
                      label="Type"
                      value={row.key}
                      placeholder="aadhaar"
                      containerClassName="flex-1"
                      onChange={(value) => updateGovIdRow(index, { key: value })}
                    />
                    <Field
                      label="Number"
                      value={row.value}
                      containerClassName="flex-1"
                      onChange={(value) => updateGovIdRow(index, { value })}
                    />
                    <SketchButton
                      size="sm"
                      variant="ghost"
                      accent="red"
                      aria-label={`Remove government ID ${index + 1}`}
                      className="w-8 shrink-0 px-0"
                      onClick={() => setGovIdRows((rows) => rows.filter((_, i) => i !== index))}
                    >
                      ✕
                    </SketchButton>
                  </div>
                ))}
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-sketch text-xs font-semibold uppercase tracking-wide text-ink-500">Bank</span>
                  <SketchButton
                    size="sm"
                    variant="ghost"
                    aria-label="Add bank detail"
                    className="shrink-0"
                    onClick={() => setBankRows((rows) => [...rows, { key: '', value: '' }])}
                  >
                    ＋ Add
                  </SketchButton>
                </div>
                {bankRows.length === 0 ? (
                  <EmptyState
                    icon="🏦"
                    text="Nothing saved — add an account only if a form actually asks for it."
                  />
                ) : null}
                {bankRows.map((row, index) => (
                  <div key={index} className="flex items-end gap-2">
                    <Field
                      label="Field"
                      value={row.key}
                      placeholder="accountNumber"
                      containerClassName="flex-1"
                      onChange={(value) => updateBankRow(index, { key: value })}
                    />
                    <Field
                      label="Value"
                      value={row.value}
                      containerClassName="flex-1"
                      onChange={(value) => updateBankRow(index, { value })}
                    />
                    <SketchButton
                      size="sm"
                      variant="ghost"
                      accent="red"
                      aria-label={`Remove bank detail ${index + 1}`}
                      className="w-8 shrink-0 px-0"
                      onClick={() => setBankRows((rows) => rows.filter((_, i) => i !== index))}
                    >
                      ✕
                    </SketchButton>
                  </div>
                ))}
              </div>

              <SketchButton size="sm" variant="ghost" onClick={hideSecrets}>
                Hide
              </SketchButton>
            </div>
          )
        ) : null}
      </SketchCard>
    </>
  ) : null;

  /* --- render ------------------------------------------------------- */

  const statusAccent: AccentName = status === 'unlocked' ? 'green' : status === 'new' ? 'amber' : 'sky';
  const statusLabel = status === 'unlocked' ? 'unlocked' : status === 'new' ? 'new' : 'locked';

  return (
    <div className="diggy-root diggy-panel diggy-panel-enter flex h-full min-h-0 flex-1 flex-col bg-paper text-ink">
      <header className="diggy-panel-header flex shrink-0 items-center justify-between gap-2 border-b-2 border-ink/10 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <SketchBadge accent="violet" size="md" dot className="diggy-panel-title">
            Vault
          </SketchBadge>
          <SketchBadge accent={statusAccent} size="sm">
            {statusLabel}
          </SketchBadge>
        </div>
        <SketchButton
          size="sm"
          variant="ghost"
          aria-label="Close vault"
          title="Close"
          className="w-8 shrink-0 px-0"
          onClick={onClose}
        >
          ✕
        </SketchButton>
      </header>

      <div className="diggy-scrollbar min-h-0 flex-1 space-y-3 overflow-y-auto overflow-x-hidden px-3 py-3">
        {!ready ? (
          <div className="grid place-items-center py-6">
            <ThinkingDots label="Loading vault…" />
          </div>
        ) : status === 'unlocked' && profile ? (
          editor
        ) : (
          lockScreen
        )}
      </div>
    </div>
  );
}

'use client';

/**
 * Profile & Settings panel, shared by all four portals.
 *
 * ── Why this is one component rather than four ─────────────────────────────
 * The four portals differ only in which page mounts this. A per-portal copy
 * would be four places to keep the field whitelist, the password rules and the
 * preferences fallback in agreement — the exact kind of duplication where a
 * security rule gets tightened in one file and not the others.
 *
 * ── Nothing here can change `role` or `status` ──────────────────────────────
 * Neither is sent from this component at all, and `/api/profile` builds its
 * update payload by copying named fields rather than spreading the request body.
 * Those are independent layers: the RLS trigger would reject the write even if a
 * crafted request reached the route.
 *
 * ── Theme: localStorage first, table second ─────────────────────────────────
 * next-themes resolves the active scheme from localStorage because that has to
 * happen before first paint. The `user_preferences` row records the *choice* so
 * it follows the user to a second device. The stored theme is therefore only
 * adopted on load when the row actually exists (`persisted: true`) — applying a
 * synthesised default of 'system' would silently overwrite a deliberate
 * localStorage choice on the user's own machine.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { fetchApiJson } from '@/lib/api-client';
import { useThemePreference } from '@/lib/theme-preference';
import { ThemeToggle } from '@/components/ui/theme-toggle';

type Profile = {
  id: string;
  email: string;
  fullName: string | null;
  role: string;
  status: string;
  phone: string | null;
  createdAt: string;
};

type Preferences = {
  emailAlerts: boolean;
  smsReminders: boolean;
  /**
   * Read-only here. The theme is written through `ThemeToggle`, which routes the
   * change through `useThemePreference` so the header toggle and this panel
   * cannot end up persisting conflicting values.
   */
  theme: 'system' | 'light' | 'dark';
};

type PreferencesResponse = {
  ok: true;
  persisted: boolean;
  preferences: Preferences;
  updatedAt?: string;
};

/**
 * Device-local fallback key for the notification toggles.
 *
 * The theme is deliberately absent: next-themes already persists it under
 * `astar-theme`, and a second copy here could disagree with the one that
 * actually drives the page.
 */
const LOCAL_PREFS_KEY = 'astar-prefs-notifications';

type LocalPrefs = Pick<Preferences, 'emailAlerts' | 'smsReminders'>;

const DEFAULT_PREFS: Preferences = {
  emailAlerts: true,
  smsReminders: false,
  theme: 'system',
};

/**
 * The failure codes that mean "the preferences table is not provisioned yet".
 *
 * `database_schema_not_applied` is the expected state until section 2 of
 * supabase/baseline.sql has been run. The panel keeps working from localStorage
 * rather than presenting the Settings page as broken, because the theme and the
 * toggles are still fully usable on one device.
 */
const MISSING_TABLE_CODES = new Set([
  'database_schema_not_applied',
  'not_found',
]);

type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved'; message: string }
  | { kind: 'error'; message: string };

const IDLE: SaveState = { kind: 'idle' };

function readLocalPrefs(): LocalPrefs | null {
  try {
    const raw = window.localStorage.getItem(LOCAL_PREFS_KEY);

    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as Partial<LocalPrefs>;

    return {
      emailAlerts:
        typeof parsed.emailAlerts === 'boolean' ? parsed.emailAlerts : DEFAULT_PREFS.emailAlerts,
      smsReminders:
        typeof parsed.smsReminders === 'boolean'
          ? parsed.smsReminders
          : DEFAULT_PREFS.smsReminders,
    };
  } catch {
    // Corrupt JSON or storage disabled (private browsing). Treated as "no saved
    // value" rather than an error the user has to dismiss.
    return null;
  }
}

function writeLocalPrefs(prefs: LocalPrefs) {
  try {
    window.localStorage.setItem(LOCAL_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Storage can be full or disabled. The server copy is still attempted, so a
    // failure here is not worth interrupting the user over.
  }
}

/** `role` and `status` rendered as readable labels rather than raw enum values. */
function humanise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1).replace(/_/g, ' ');
}

const ROLE_TONE: Record<string, string> = {
  ceo: 'border-accent/40 bg-accent/10 text-accent',
  manager: 'border-chart-billed/40 bg-chart-billed/10 text-chart-billed',
  driver: 'border-line-strong bg-surface-2 text-content-muted',
  developer: 'border-chart-servicing/40 bg-chart-servicing/5 text-chart-servicing',
};

const STATUS_TONE: Record<string, string> = {
  active: 'border-chart-collected/40 bg-chart-collected/10 text-chart-collected',
  pending: 'border-chart-servicing/40 bg-chart-servicing/5 text-chart-servicing',
  suspended: 'border-accent/40 bg-accent/10 text-accent',
};

function Badge({ tone, children }: { tone: string; children: React.ReactNode }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold ${tone}`}>
      {children}
    </span>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="card">
      <div className="mb-5">
        <h2 className="text-lg font-semibold text-content">{title}</h2>
        <p className="mt-1 text-sm text-content-subtle">{description}</p>
      </div>
      {children}
    </section>
  );
}

/**
 * Form control styling.
 *
 * `border-line-strong` rather than `border-line`: the plain hairline is ~1.2:1
 * against a card, so an input bordered with it is very hard to see on a light
 * canvas. A form field's boundary is load-bearing — it is what tells you where
 * to click and where to type — so it meets the 3:1 non-text threshold.
 */
const inputClass =
  'w-full rounded-xl border border-line-strong bg-surface-2 px-3.5 py-2.5 text-sm text-content outline-none transition placeholder:text-content-subtle focus:border-accent';

/** A labelled switch. `role="switch"` so screen readers announce on/off, not a checkbox. */
function Switch({
  id,
  label,
  description,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div className="min-w-0">
        <label htmlFor={id} className="block text-sm font-medium text-content">
          {label}
        </label>
        <p className="mt-0.5 text-xs text-content-subtle">{description}</p>
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition ${
          checked ? 'bg-accent' : 'bg-line-strong'
        }`}
      >
        <span
          className={`inline-block h-4 w-4 transform rounded-full bg-white transition ${
            checked ? 'translate-x-6' : 'translate-x-1'
          }`}
        />
      </button>
    </div>
  );
}

export function ProfileSettings() {
  // ── Profile ──────────────────────────────────────────────────────────────
  const [profile, setProfile] = useState<Profile | null>(null);
  const [profileError, setProfileError] = useState<{ code: string; message: string } | null>(null);
  const [loadingProfile, setLoadingProfile] = useState(true);

  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [profileSave, setProfileSave] = useState<SaveState>(IDLE);

  // ── Password ─────────────────────────────────────────────────────────────
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordSave, setPasswordSave] = useState<SaveState>(IDLE);

  // ── Preferences ──────────────────────────────────────────────────────────
  // `theme` is read for display only. Writes go through ThemeToggle, so this
  // panel cannot persist a stale copy of a theme the user just changed in the
  // header.
  const { theme, setTheme } = useThemePreference();
  const [prefs, setPrefs] = useState<Preferences>(DEFAULT_PREFS);
  const [prefsPersisted, setPrefsPersisted] = useState(false);
  const [deviceOnly, setDeviceOnly] = useState(false);
  const [prefsSave, setPrefsSave] = useState<SaveState>(IDLE);

  /**
   * Guards the load-time theme adoption.
   *
   * next-themes writes to localStorage when `setTheme` runs. Without this ref a
   * second fetch (React strict mode double-invokes effects in development)
   * could re-apply and fight the user's most recent manual choice.
   */
  const appliedStoredTheme = useRef(false);

  const loadProfile = useCallback(async () => {
    setLoadingProfile(true);

    const result = await fetchApiJson<{ ok: true; profile: Profile }>('/api/profile');

    if (!result.ok) {
      setProfileError({ code: result.code, message: result.message });
      setProfile(null);
      setLoadingProfile(false);
      return;
    }

    setProfileError(null);
    setProfile(result.data.profile);
    setFullName(result.data.profile.fullName ?? '');
    setPhone(result.data.profile.phone ?? '');
    setLoadingProfile(false);
  }, []);

  useEffect(() => {
    void loadProfile();
  }, [loadProfile]);

  const loadPreferences = useCallback(async () => {
    const result = await fetchApiJson<PreferencesResponse>('/api/profile/preferences');

    if (!result.ok) {
      // Not an error state: the toggles still work from localStorage, so the
      // panel stays usable and simply records that the choice is device-local.
      setDeviceOnly(MISSING_TABLE_CODES.has(result.code));
      const local = readLocalPrefs();

      if (local) {
        // Merged rather than assigned: the theme is deliberately absent from the
        // device-local copy, so replacing the whole object here would reset it
        // to 'system' and contradict whatever next-themes already resolved.
        setPrefs((current) => ({ ...current, ...local }));
      }

      return;
    }

    const { preferences, persisted } = result.data;

    setPrefs(preferences);
    setPrefsPersisted(persisted);
    setDeviceOnly(false);

    // Only adopted when the row really exists. See the file header: applying a
    // synthesised default would clobber a deliberate localStorage choice.
    if (persisted && !appliedStoredTheme.current) {
      appliedStoredTheme.current = true;
      setTheme(preferences.theme);
    }
  }, [setTheme]);

  useEffect(() => {
    void loadPreferences();
  }, [loadPreferences]);

  async function saveProfile(event: React.FormEvent) {
    event.preventDefault();
    setProfileSave({ kind: 'saving' });

    const result = await fetchApiJson<{ ok: true; profile: Profile }>('/api/profile', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      // `role` and `status` are not part of this payload. The route would ignore
      // them regardless; omitting them keeps the client honest too.
      body: JSON.stringify({ full_name: fullName, phone }),
    });

    if (!result.ok) {
      setProfileSave({ kind: 'error', message: result.message });
      return;
    }

    setProfile(result.data.profile);
    setFullName(result.data.profile.fullName ?? '');
    setPhone(result.data.profile.phone ?? '');
    setProfileSave({ kind: 'saved', message: 'Your details have been saved.' });
  }

  async function changePassword(event: React.FormEvent) {
    event.preventDefault();

    // Checked client-side so the obvious mistake does not cost a round trip.
    // The server enforces the same rules independently; this is convenience, not
    // the security boundary.
    if (newPassword !== confirmPassword) {
      setPasswordSave({
        kind: 'error',
        message: 'The two new passwords do not match.',
      });
      return;
    }

    setPasswordSave({ kind: 'saving' });

    const result = await fetchApiJson<{ ok: true; message: string }>('/api/profile/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword, newPassword }),
    });

    if (!result.ok) {
      setPasswordSave({ kind: 'error', message: result.message });
      return;
    }

    // The fields are cleared on success so the new password is not left sitting
    // in the DOM after the change is done.
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
    setPasswordSave({
      kind: 'saved',
      message: 'Your password has been changed.',
    });
  }

  async function saveNotifications(next: LocalPrefs) {
    setPrefs((current) => ({ ...current, ...next }));
    // Mirrored locally first so a failed server write still leaves the choice in
    // effect on this device rather than snapping the toggle back.
    writeLocalPrefs(next);
    setPrefsSave({ kind: 'saving' });

    const result = await fetchApiJson<PreferencesResponse>('/api/profile/preferences', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      // `theme` is intentionally not sent. Including a value captured from this
      // component's render would overwrite a theme change made in the header
      // moments earlier, because this handler runs on a stale closure.
      body: JSON.stringify({
        email_alerts: next.emailAlerts,
        sms_reminders: next.smsReminders,
      }),
    });

    if (!result.ok) {
      setDeviceOnly(MISSING_TABLE_CODES.has(result.code));
      setPrefsSave({
        kind: 'error',
        message: `${result.message} Your choice is saved on this device only.`,
      });
      return;
    }

    setPrefsPersisted(true);
    setPrefsSave({ kind: 'saved', message: 'Your preferences have been saved.' });
  }

  const roleTone = ROLE_TONE[profile?.role ?? ''] ?? 'border-line-strong bg-surface-2 text-content-muted';
  const statusTone = STATUS_TONE[profile?.status ?? ''] ?? 'border-line-strong bg-surface-2 text-content-muted';

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight text-content">Profile &amp; Settings</h1>
        <p className="mt-1 text-sm text-content-subtle">
          Your account details, sign-in security and notification preferences.
        </p>
      </header>

      {/* ── Account summary ────────────────────────────────────────────── */}
      <Section
        title="Account"
        description="Your role and account status are set by an administrator and cannot be changed here."
      >
        {loadingProfile ? (
          <p className="text-sm text-content-subtle">Loading your account details…</p>
        ) : profileError ? (
          <div
            role="alert"
            className="rounded-xl border border-accent/40 bg-accent/10 px-4 py-3 text-sm text-accent"
          >
            {profileError.message}
          </div>
        ) : profile ? (
          <dl className="grid gap-4 sm:grid-cols-2">
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wide text-content-subtle">
                Full name
              </dt>
              <dd className="mt-1 text-sm text-content">{profile.fullName ?? 'Not set'}</dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wide text-content-subtle">
                Email
              </dt>
              <dd className="mt-1 break-all text-sm text-content">{profile.email}</dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wide text-content-subtle">Role</dt>
              <dd className="mt-1">
                <Badge tone={roleTone}>{humanise(profile.role)}</Badge>
              </dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wide text-content-subtle">
                Status
              </dt>
              <dd className="mt-1">
                <Badge tone={statusTone}>{humanise(profile.status)}</Badge>
              </dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wide text-content-subtle">
                Member since
              </dt>
              <dd className="mt-1 text-sm text-content">
                {new Date(profile.createdAt).toLocaleDateString('en-KE', {
                  day: '2-digit',
                  month: 'long',
                  year: 'numeric',
                })}
              </dd>
            </div>
          </dl>
        ) : null}
      </Section>

      {/* ── Personal info ──────────────────────────────────────────────── */}
      <Section
        title="Personal information"
        description="Update the name and phone number shown to your colleagues."
      >
        <form onSubmit={saveProfile} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="full-name" className="mb-1.5 block text-sm font-medium text-content">
                Full name
              </label>
              <input
                id="full-name"
                type="text"
                value={fullName}
                onChange={(event) => setFullName(event.target.value)}
                maxLength={120}
                autoComplete="name"
                placeholder="e.g. Achieng Otieno"
                className={inputClass}
              />
            </div>
            <div>
              <label htmlFor="phone" className="mb-1.5 block text-sm font-medium text-content">
                Phone number
              </label>
              <input
                id="phone"
                type="tel"
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                maxLength={32}
                autoComplete="tel"
                placeholder="+254 7XX XXX XXX"
                className={inputClass}
              />
            </div>
          </div>

          {profileSave.kind === 'error' ? (
            <p role="alert" className="text-sm text-accent">
              {profileSave.message}
            </p>
          ) : null}
          {profileSave.kind === 'saved' ? (
            <p role="status" className="text-sm text-chart-collected">
              {profileSave.message}
            </p>
          ) : null}

          <button
            type="submit"
            disabled={profileSave.kind === 'saving'}
            className="rounded-xl bg-brand-solid px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-solid-strong disabled:cursor-not-allowed disabled:opacity-60"
          >
            {profileSave.kind === 'saving' ? 'Saving…' : 'Save changes'}
          </button>
        </form>
      </Section>

      {/* ── Security ───────────────────────────────────────────────────── */}
      <Section
        title="Security"
        description="Changing your password requires your current one, so an unattended session cannot lock you out."
      >
        <form onSubmit={changePassword} className="space-y-4">
          <div>
            <label htmlFor="current-password" className="mb-1.5 block text-sm font-medium text-content">
              Current password
            </label>
            <input
              id="current-password"
              type="password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              autoComplete="current-password"
              required
              className={inputClass}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="new-password" className="mb-1.5 block text-sm font-medium text-content">
                New password
              </label>
              <input
                id="new-password"
                type="password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                autoComplete="new-password"
                minLength={8}
                required
                className={inputClass}
              />
              <p className="mt-1.5 text-xs text-content-subtle">
                At least 8 characters, including a letter and a number.
              </p>
            </div>
            <div>
              <label
                htmlFor="confirm-password"
                className="mb-1.5 block text-sm font-medium text-content"
              >
                Confirm new password
              </label>
              <input
                id="confirm-password"
                type="password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                autoComplete="new-password"
                minLength={8}
                required
                className={inputClass}
              />
            </div>
          </div>

          {passwordSave.kind === 'error' ? (
            <p role="alert" className="text-sm text-accent">
              {passwordSave.message}
            </p>
          ) : null}
          {passwordSave.kind === 'saved' ? (
            <p role="status" className="text-sm text-chart-collected">
              {passwordSave.message}
            </p>
          ) : null}

          <button
            type="submit"
            disabled={passwordSave.kind === 'saving'}
            className="rounded-xl bg-brand-solid px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-solid-strong disabled:cursor-not-allowed disabled:opacity-60"
          >
            {passwordSave.kind === 'saving' ? 'Updating…' : 'Change password'}
          </button>
        </form>
      </Section>

      {/* ── Notifications & appearance ─────────────────────────────────── */}
      <Section
        title="Notifications &amp; appearance"
        description="How you are notified, and which colour scheme the app uses."
      >
        {deviceOnly ? (
          <div
            role="status"
            className="mb-4 rounded-xl border border-chart-servicing/40 bg-chart-servicing/5 px-4 py-3 text-sm text-chart-servicing"
          >
            Preferences are stored on this device only. Run the latest
            {' '}
            <code className="font-mono text-xs">supabase/baseline.sql</code> to save them to your
            account.
          </div>
        ) : null}

        <div className="divide-y divide-line">
          <Switch
            id="email-alerts"
            label="Email alerts"
            description="Remittance confirmations and document review outcomes."
            checked={prefs.emailAlerts}
            onChange={(next) => void saveNotifications({ emailAlerts: next, smsReminders: prefs.smsReminders })}
          />
          <Switch
            id="sms-reminders"
            label="SMS reminders"
            description="Short message reminders before a remittance is due."
            checked={prefs.smsReminders}
            onChange={(next) => void saveNotifications({ emailAlerts: prefs.emailAlerts, smsReminders: next })}
          />
        </div>

        <div className="mt-5 border-t border-line pt-5">
          <span id="theme-preference-label" className="block text-sm font-medium text-content">
            Theme
          </span>
          <p className="mt-0.5 text-xs text-content-subtle">
            System follows your operating&nbsp;system setting.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            {/* The segmented control is the explicit choice; the icon toggle
                beside it is the quick switch in the same header as the rest of
                the app. Both write the same preference. */}
            <ThemeToggle variant="segmented" />
            <ThemeToggle />
          </div>
          {theme ? (
            <p className="mt-3 text-xs text-content-subtle">
              Active preference: <span className="text-content-muted">{humanise(theme)}</span>
              {prefsPersisted ? '' : ' (saved on this device)'}
            </p>
          ) : null}
        </div>

        {prefsSave.kind === 'error' ? (
          <p role="alert" className="mt-4 text-sm text-accent">
            {prefsSave.message}
          </p>
        ) : null}
        {prefsSave.kind === 'saved' ? (
          <p role="status" className="mt-4 text-sm text-chart-collected">
            {prefsSave.message}
          </p>
        ) : null}
      </Section>
    </div>
  );
}
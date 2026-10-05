'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { BrandLogo } from '@/components/ui/BrandLogo';
import { createSupabaseClient } from '@/lib/supabase/client';

const roleRedirects = {
  ceo: '/ceo',
  manager: '/manager',
  driver: '/driver',
  developer: '/developer',
} as const;

const legacyAuthorizedAccounts = {
  'ceo@astar.com': 'ceo',
  'dev@astar.com': 'developer',
  'manager@astar.com': 'manager',
} as const;

async function resolveUserRole(
  supabase: ReturnType<typeof createSupabaseClient>,
  user: { id: string; email?: string | null; app_metadata?: Record<string, unknown> | null }
): Promise<'ceo' | 'manager' | 'developer' | 'driver' | null> {
  const appRole = user.app_metadata?.role as string | null | undefined;
  if (appRole && ['ceo', 'manager', 'developer', 'driver'].includes(appRole)) {
    return appRole as 'ceo' | 'manager' | 'developer' | 'driver';
  }

  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).maybeSingle();
  const profileRole = (profile as { role?: string | null } | null)?.role;
  if (profileRole && ['ceo', 'manager', 'developer', 'driver', 'suspended'].includes(profileRole)) {
    return profileRole as 'ceo' | 'manager' | 'developer' | 'driver';
  }

  const normalizedEmail = user.email?.trim().toLowerCase();
  if (!normalizedEmail) {
    return null;
  }

  return legacyAuthorizedAccounts[normalizedEmail as keyof typeof legacyAuthorizedAccounts] ?? null;
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <LoginShell
          authMode="sign-in"
          onModeChange={() => undefined}
          selectedRole="manager"
          onRoleChange={() => undefined}
          showPassword={false}
          onPasswordToggle={() => undefined}
          onEmailChange={() => undefined}
          onPasswordChange={() => undefined}
          onFullNameChange={() => undefined}
          onCompanyNameChange={() => undefined}
        />
      }
    >
      <LoginPageContent />
    </Suspense>
  );
}

function LoginPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const redirectedFrom = searchParams.get('redirectedFrom');
  const requestedRoleParam = searchParams.get('role');
  const requestedModeParam = searchParams.get('mode');
  // Driver invitation links minted by /api/manager/create-driver carry the
  // provisioned address so the driver only has to type a password.
  const invitedEmail = (searchParams.get('email') ?? '').trim();

  const [authMode, setAuthMode] = useState<'sign-in' | 'register'>(requestedModeParam === 'register' ? 'register' : 'sign-in');
  const [selectedRole, setSelectedRole] = useState<'ceo' | 'manager' | 'developer'>(
    requestedRoleParam === 'ceo' ? 'ceo' : requestedRoleParam === 'developer' ? 'developer' : 'manager'
  );
  const [showPassword, setShowPassword] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Prefill from the invitation link. Keyed on the param so it only re-runs when
  // the driver opens a different invitation, and never overwrites an address the
  // user has already typed.
  useEffect(() => {
    if (invitedEmail) {
      setEmail(invitedEmail);
    }
  }, [invitedEmail]);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setErrorMessage('');
    setIsSubmitting(true);

    try {
      const supabase = createSupabaseClient();
      const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (error) {
        setErrorMessage(error.message);
        return;
      }

      const user = data.user;
      const resolvedRole = await resolveUserRole(supabase, user);

      if (!resolvedRole) {
        setErrorMessage('This account is not authorized for Astar Travels access.');
        return;
      }

      const role = resolvedRole;
      const destination: '/ceo' | '/manager' | '/driver' | '/developer' =
        redirectedFrom && redirectedFrom.startsWith(`/${role}`)
          ? (redirectedFrom as '/ceo' | '/manager' | '/driver' | '/developer')
          : roleRedirects[role] ?? '/manager';

      router.push(destination);
      router.refresh();
    } catch {
      setErrorMessage('Unable to sign in. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <LoginShell
      authMode={authMode}
      onModeChange={setAuthMode}
      selectedRole={selectedRole}
      onRoleChange={setSelectedRole}
      showPassword={showPassword}
      onPasswordToggle={() => setShowPassword((current) => !current)}
      email={email}
      password={password}
      fullName={fullName}
      companyName={companyName}
      errorMessage={errorMessage}
      isSubmitting={isSubmitting}
      onEmailChange={setEmail}
      onPasswordChange={setPassword}
      onFullNameChange={setFullName}
      onCompanyNameChange={setCompanyName}
      onSubmit={handleSubmit}
    />
  );
}

function LoginShell({
  authMode,
  onModeChange,
  selectedRole,
  onRoleChange,
  showPassword,
  onPasswordToggle,
  email,
  password,
  fullName,
  companyName,
  errorMessage,
  isSubmitting,
  onEmailChange,
  onPasswordChange,
  onFullNameChange,
  onCompanyNameChange,
  onSubmit,
}: {
  authMode: 'sign-in' | 'register';
  onModeChange: (mode: 'sign-in' | 'register') => void;
  selectedRole: 'ceo' | 'manager' | 'developer';
  onRoleChange: (role: 'ceo' | 'manager' | 'developer') => void;
  showPassword: boolean;
  onPasswordToggle: () => void;
  email?: string;
  password?: string;
  fullName?: string;
  companyName?: string;
  errorMessage?: string;
  isSubmitting?: boolean;
  onEmailChange?: (value: string) => void;
  onPasswordChange?: (value: string) => void;
  onFullNameChange?: (value: string) => void;
  onCompanyNameChange?: (value: string) => void;
  onSubmit?: (event: React.FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas px-4 py-10">
      <div className="grid w-full max-w-6xl overflow-hidden rounded-[2rem] border border-line bg-surface/60 shadow-[0_30px_80px_rgba(18,20,24,0.45)] backdrop-blur-md lg:grid-cols-[1.1fr_0.9fr]">
        <section className="flex flex-col justify-between bg-gradient-to-br from-canvas via-surface to-canvas p-8 text-content lg:p-12">
          <div>
            <div className="mb-8 flex items-center gap-3">
              <BrandLogo size="md" variant="full" className="drop-shadow-[0_0_12px_rgba(255,78,66,0.3)]" />
            </div>

            <div className="space-y-6">
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-accent">Secure access</p>
              <h1 className="max-w-md text-4xl font-black tracking-tight md:text-5xl">
                Move your fleet, finance and compliance forward.
              </h1>
              <p className="max-w-md text-base text-content-subtle">
                Sign in to manage trip operations, track driver remittances, and keep executive oversight in real time.
              </p>
            </div>
          </div>

          <div className="mt-10 grid gap-4 sm:grid-cols-3">
            {[
              { label: 'Fleet uptime', value: '98.6%' },
              { label: 'Payout speed', value: '12 min' },
              { label: 'Support SLA', value: '24/7' },
            ].map((item) => (
              <div key={item.label} className="rounded-2xl border border-line-strong bg-surface/80 p-4">
                <p className="text-xs uppercase tracking-[0.14em] text-content-subtle">{item.label}</p>
                <p className="mt-2 text-2xl font-bold text-content">{item.value}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="bg-surface-2 p-6 lg:p-10">
          <div className="mx-auto max-w-md">
            <div className="mb-6 flex rounded-full border border-line bg-surface p-1 shadow-sm">
              <div className="flex-1 rounded-full bg-canvas px-4 py-2 text-center text-sm font-semibold text-content shadow-sm">
                Sign In
              </div>
            </div>

            <div className="rounded-[1.75rem] border border-line bg-surface p-6 shadow-[0_18px_40px_rgba(18,20,24,0.08)]">
              <div className="mb-6 flex items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.2em] text-accent">Astar account</p>
                  <h2 className="mt-2 text-3xl font-bold text-content">Welcome back</h2>
                </div>
                <Link href="/" className="text-sm font-medium text-content-subtle hover:text-content">
                  Home
                </Link>
              </div>

              <form onSubmit={onSubmit} className="space-y-5">
                <div className="rounded-xl border border-accent bg-surface-2 px-3 py-2.5 text-xs font-medium text-accent">
                  Authorized accounts are limited to: CEO, Manager, and Developer.
                </div>

                <div>
                  <label className="mb-2 block text-sm font-medium text-content">Email address</label>
                  <input
                    type="email"
                    value={email ?? ''}
                    onChange={(event) => onEmailChange?.(event.target.value)}
                    required
                    className="w-full rounded-xl border border-line bg-surface-2 px-3 py-2.5 text-sm text-content outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
                    placeholder="you@astartravels.com"
                  />
                </div>

                <div>
                  <label className="mb-2 block text-sm font-medium text-content">Password</label>
                  <div className="relative">
                    <input
                      type={showPassword ? 'text' : 'password'}
                      value={password ?? ''}
                      onChange={(event) => onPasswordChange?.(event.target.value)}
                      required
                      className="w-full rounded-xl border border-line bg-surface-2 px-3 py-2.5 pr-11 text-sm text-content outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
                      placeholder={authMode === 'sign-in' ? 'Enter your password' : 'Create a secure password'}
                    />
                    <button
                      type="button"
                      onClick={onPasswordToggle}
                      className="absolute inset-y-0 right-3 flex items-center text-xs font-semibold uppercase tracking-[0.12em] text-content-subtle hover:text-content"
                    >
                      {showPassword ? 'Hide' : 'Show'}
                    </button>
                  </div>
                </div>

                {errorMessage ? (
                  <div className="rounded-xl border border-chart-danger/30 bg-chart-danger/10 px-3 py-2 text-sm text-chart-danger">{errorMessage}</div>
                ) : null}

                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="w-full rounded-xl bg-brand-solid px-4 py-3 text-sm font-semibold text-white shadow-[0_0_12px_rgba(255,78,66,0.35)] transition hover:bg-brand-solid-strong disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isSubmitting ? (authMode === 'sign-in' ? 'Signing in...' : 'Creating account...') : authMode === 'sign-in' ? 'Sign in to dashboard' : 'Create my account'}
                </button>
              </form>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}

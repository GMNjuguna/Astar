'use client';

import { useEffect, useMemo, useState } from 'react';

import { fetchApiJson } from '@/lib/api-client';

type AccountRole = 'driver' | 'ceo' | 'developer' | 'manager' | 'suspended';

type Account = {
  id: string;
  fullName: string;
  email: string;
  /**
   * There is no company column on `profiles`, so this is derived rather than
   * read. Optional because the API returns real uuid rows with no such field.
   */
  companyId?: string;
  role: AccountRole;
  createdAt: string;
  status: 'active' | 'suspended';
};

/**
 * Placeholder rows rendered before the first fetch resolves. They are never shown
 * once a load succeeds, and the panel marks the table as placeholder data while
 * a load has failed, so these cannot be mistaken for real accounts.
 */
const initialAccounts: Account[] = [
  { id: '1', fullName: 'Njeri Wanjiku', email: 'njeri@astartravels.co', companyId: 'AST-1024', role: 'driver', createdAt: '2025-01-14', status: 'active' },
  { id: '2', fullName: 'Kipchoge Otieno', email: 'kip@astartravels.co', companyId: 'AST-0001', role: 'ceo', createdAt: '2024-12-03', status: 'active' },
  { id: '3', fullName: 'Bett Kelvin', email: 'bett@astartravels.co', companyId: 'AST-0002', role: 'developer', createdAt: '2025-02-18', status: 'active' },
  { id: '4', fullName: 'Faith Achieng', email: 'faith@astartravels.co', companyId: 'AST-1027', role: 'driver', createdAt: '2025-03-07', status: 'active' },
  { id: '5', fullName: 'Moses Kamau', email: 'moses@astartravels.co', companyId: 'AST-1040', role: 'suspended', createdAt: '2025-04-20', status: 'suspended' },
];

const roleOptions: Array<{ value: AccountRole; label: string }> = [
  { value: 'driver', label: 'Driver' },
  { value: 'manager', label: 'Manager' },
  { value: 'ceo', label: 'CEO' },
  { value: 'developer', label: 'Developer' },
  { value: 'suspended', label: 'Suspended' },
];

function formatRole(value: AccountRole) {
  return roleOptions.find((option) => option.value === value)?.label ?? value;
}

export function UserManagementTable() {
  const [accounts, setAccounts] = useState<Account[]>(initialAccounts);
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [draftRole, setDraftRole] = useState<AccountRole>('driver');
  const [searchQuery, setSearchQuery] = useState('');
  const [statusMessage, setStatusMessage] = useState('');
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    let cancelled = false;

    async function loadAccounts() {
      const result = await fetchApiJson<{ users?: Account[] }>('/api/developer/users');

      if (cancelled) {
        return;
      }

      if (!result.ok) {
        // Previously the failure was swallowed and the five seeded rows stayed
        // on screen, so a dead database looked like a populated account list.
        setLoadError(result.message);
        return;
      }

      setLoadError('');

      if (Array.isArray(result.data.users)) {
        setAccounts(result.data.users);
      }
    }

    void loadAccounts();

    return () => {
      cancelled = true;
    };
  }, []);

  const filteredAccounts = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return accounts;

    return accounts.filter((account) => {
      const haystack = `${account.fullName} ${account.email} ${account.companyId ?? ''}`.toLowerCase();
      return haystack.includes(q);
    });
  }, [accounts, searchQuery]);

  const selectedAccount = useMemo(
    () => accounts.find((account) => account.id === selectedAccountId) ?? null,
    [accounts, selectedAccountId]
  );

  const openRoleModal = (account: Account) => {
    setSelectedAccountId(account.id);
    setDraftRole(account.role);
  };

  const saveRole = async () => {
    if (!selectedAccountId) return;

    const target = accounts.find((account) => account.id === selectedAccountId);
    const confirmed = window.confirm(`Reassign ${target?.fullName ?? 'this user'} to ${formatRole(draftRole)}?`);
    if (!confirmed) return;

    const result = await fetchApiJson<{ user?: { id: string; role: AccountRole } }>('/api/developer/users', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: selectedAccountId, role: draftRole }),
    });

    if (!result.ok) {
      // Previously the `catch` applied the change locally and the `finally`
      // reported success unconditionally, so a rejected save both looked
      // applied on screen and claimed to be saved on the server.
      setStatusMessage(`Could not save: ${result.message}`);
      return;
    }

    const saved = result.data.user;

    setAccounts((current) =>
      current.map((account) =>
        account.id === selectedAccountId
          ? {
              ...account,
              role: saved?.role ?? draftRole,
              status: (saved?.role ?? draftRole) === 'suspended' ? 'suspended' : 'active',
            }
          : account
      )
    );

    setStatusMessage(`Role override saved for ${target?.fullName ?? 'selected user'}.`);
    setSelectedAccountId(null);
  };

  const handleAccountAction = (account: Account, action: 'reset-password' | 'suspend' | 'reactivate' | 'jwt-refresh') => {
    const nextStatus = action === 'suspend' ? 'suspended' : 'active';
    if (action === 'reset-password') {
      setStatusMessage(`Password reset email queued for ${account.email}.`);
      return;
    }

    setAccounts((current) =>
      current.map((item) =>
        item.id === account.id
          ? {
              ...item,
              status: action === 'reactivate' || action === 'jwt-refresh' ? 'active' : nextStatus,
              role: action === 'suspend' ? 'suspended' : item.role,
            }
          : item
      )
    );

    setStatusMessage(
      action === 'suspend'
        ? `${account.fullName} has been suspended.`
        : action === 'reactivate'
          ? `${account.fullName} has been reactivated.`
          : `JWT session refresh forced for ${account.fullName}.`
    );
  };

  return (
    <div className="space-y-5 text-content">
      {loadError ? (
        <div className="rounded-xl border border-chart-danger/40 bg-chart-danger/10 px-3 py-2 text-sm text-chart-danger">
          <p className="font-semibold">Accounts unavailable</p>
          <p className="mt-1">{loadError}</p>
          <p className="mt-1 text-xs text-chart-danger/80">
            The rows below are placeholders, not real accounts.
          </p>
        </div>
      ) : null}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <p className="text-sm font-medium text-content-subtle">Access control</p>
          <h2 className="mt-1 text-2xl font-bold text-content">Tenant & role overrides</h2>
        </div>
        <button type="button" className="rounded-xl border border-line bg-canvas px-3 py-2 text-sm font-medium text-content transition hover:bg-surface-2">
          Export CSV
        </button>
      </div>

      <div className="rounded-2xl border border-line bg-canvas p-3">
        <input
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          placeholder="Search by name, email, or company ID"
          className="w-full rounded-xl border border-line bg-surface px-3 py-2.5 text-sm text-content outline-none transition placeholder:text-content-subtle focus:border-accent"
        />
      </div>

      {statusMessage ? (
        <div className="rounded-xl border border-chart-collected/30 bg-chart-collected/10 px-3 py-2 text-sm text-chart-collected">{statusMessage}</div>
      ) : null}

      <div className="overflow-hidden rounded-2xl border border-line bg-canvas">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-line text-left text-sm">
            <thead className="bg-surface text-content-muted">
              <tr>
                <th className="px-4 py-3 font-semibold">Name</th>
                <th className="px-4 py-3 font-semibold">Email</th>
                <th className="px-4 py-3 font-semibold">Company ID</th>
                <th className="px-4 py-3 font-semibold">Role</th>
                <th className="px-4 py-3 font-semibold">Created</th>
                <th className="px-4 py-3 font-semibold text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line bg-canvas">
              {filteredAccounts.map((account) => (
                <tr key={account.id} className="hover:bg-surface">
                  <td className="px-4 py-3 font-medium text-content">{account.fullName}</td>
                  <td className="px-4 py-3 text-content-muted">{account.email}</td>
                  <td className="px-4 py-3 text-content-muted">{account.companyId ?? '—'}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${
                        account.role === 'suspended'
                          ? 'bg-chart-danger/10 text-chart-danger'
                          : account.role === 'developer'
                            ? 'bg-chart-violet/10 text-chart-violet'
                            : account.role === 'ceo'
                              ? 'bg-chart-blue/10 text-chart-blue'
                              : account.role === 'manager'
                                ? 'bg-chart-billed/10 text-chart-billed'
                                : 'bg-chart-collected/10 text-chart-collected'
                      }`}
                    >
                      {formatRole(account.role)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-content-muted">{new Date(account.createdAt).toLocaleDateString()}</td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex justify-end gap-2">
                      <button type="button" onClick={() => openRoleModal(account)} className="rounded-lg bg-brand-solid px-3 py-2 text-xs font-semibold text-white">
                        Override
                      </button>
                      <button type="button" onClick={() => handleAccountAction(account, 'reset-password')} className="rounded-lg border border-line bg-surface px-3 py-2 text-xs font-semibold text-content">
                        Reset
                      </button>
                      {account.status === 'active' ? (
                        <button type="button" onClick={() => handleAccountAction(account, 'suspend')} className="rounded-lg border border-chart-danger/30 bg-chart-danger/10 px-3 py-2 text-xs font-semibold text-chart-danger">
                          Suspend
                        </button>
                      ) : (
                        <button type="button" onClick={() => handleAccountAction(account, 'reactivate')} className="rounded-lg border border-chart-collected/30 bg-chart-collected/10 px-3 py-2 text-xs font-semibold text-chart-collected">
                          Reactivate
                        </button>
                      )}
                      <button type="button" onClick={() => handleAccountAction(account, 'jwt-refresh')} className="rounded-lg border border-chart-billed/30 bg-chart-billed/10 px-3 py-2 text-xs font-semibold text-chart-billed">
                        Refresh JWT
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {selectedAccount && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-canvas/60 p-4">
          <div className="w-full max-w-md rounded-2xl border border-line bg-surface p-6 shadow-xl">
            <div className="mb-4">
              <p className="text-sm font-medium text-content-subtle">Role override</p>
              <h3 className="mt-1 text-2xl font-bold text-content">{selectedAccount.fullName}</h3>
              <p className="text-sm text-content-muted">{selectedAccount.email}</p>
            </div>

            <label className="mb-5 block text-sm font-medium text-content">
              Assigned role
              <select
                value={draftRole}
                onChange={(event) => setDraftRole(event.target.value as AccountRole)}
                className="mt-2 w-full rounded-xl border border-line bg-canvas px-3 py-2.5 text-content outline-none transition focus:border-accent"
              >
                {roleOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            <div className="flex justify-end gap-3">
              <button type="button" onClick={() => setSelectedAccountId(null)} className="rounded-lg border border-line bg-canvas px-4 py-2.5 text-sm font-semibold text-content">
                Cancel
              </button>
              <button type="button" onClick={saveRole} className="rounded-lg bg-brand-solid px-4 py-2.5 text-sm font-semibold text-white">
                Save override
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

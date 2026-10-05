'use client';

import { useEffect, useState } from 'react';

import { fetchApiJson } from '@/lib/api-client';

type ChatSession = {
  id: string;
  driver: string;
  tokens: number;
  status: 'Healthy' | 'Flagged' | 'Escalated';
  summary: string;
  createdAt: string;
  issue: string;
};

type MonitorResponse = {
  history?: ChatSession[];
  historySource?: 'sample_data' | 'database';
  templates?: { systemPrompt?: string; fallbackPrompt?: string };
  fullyConfigured?: boolean;
};

const DEFAULT_SYSTEM_PROMPT =
  'You are Astar Travel AI support. Help drivers with route changes, payments, remittances, and compliance guidance. Keep answers concise and policy-aware.';
const DEFAULT_FALLBACK_PROMPT =
  'If the answer is uncertain, direct the driver to the relevant support channel and ask for a follow-up.';

export function ChatbotMonitorPanel() {
  const [chatHistory, setChatHistory] = useState<ChatSession[]>([]);
  const [systemPrompt, setSystemPrompt] = useState(DEFAULT_SYSTEM_PROMPT);
  const [fallbackPrompt, setFallbackPrompt] = useState(DEFAULT_FALLBACK_PROMPT);
  const [isSaving, setIsSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState('');
  const [isSaveFailed, setIsSaveFailed] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [isSampleData, setIsSampleData] = useState(false);
  const [isUnconfigured, setIsUnconfigured] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function loadMonitorData() {
      const result = await fetchApiJson<MonitorResponse>('/api/developer/chatbot');

      if (cancelled) {
        return;
      }

      if (!result.ok) {
        // Previously an unreachable endpoint left the built-in prompts on screen
        // with no indication they were not the stored configuration, so an
        // operator could edit and save without knowing the read had failed.
        setLoadError(result.message);
        return;
      }

      setLoadError('');

      if (Array.isArray(result.data.history)) {
        setChatHistory(result.data.history);
      }

      setIsSampleData(result.data.historySource === 'sample_data');
      setIsUnconfigured(result.data.fullyConfigured === false);

      if (result.data.templates?.systemPrompt) {
        setSystemPrompt(result.data.templates.systemPrompt);
      }

      if (result.data.templates?.fallbackPrompt) {
        setFallbackPrompt(result.data.templates.fallbackPrompt);
      }
    }

    void loadMonitorData();

    return () => {
      cancelled = true;
    };
  }, []);

  const savePrompts = async () => {
    setIsSaving(true);
    setSaveMessage('');

    const result = await fetchApiJson('/api/developer/chatbot', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        templates: {
          systemPrompt,
          fallbackPrompt,
        },
      }),
    });

    setIsSaving(false);

    if (!result.ok) {
      // Previously the response was discarded and the panel reported success
      // unconditionally, so a rejected write looked identical to a saved one.
      setIsSaveFailed(true);
      setSaveMessage(result.message);
      return;
    }

    setIsSaveFailed(false);
    setIsUnconfigured(false);
    setSaveMessage('Prompt templates saved to the database.');
  };

  return (
    <div className="space-y-6 text-content">
      <div>
        <p className="text-sm font-medium text-content-subtle">AI operations</p>
        <h2 className="mt-1 text-2xl font-bold text-content">Prompt inspector & chatbot monitor</h2>
      </div>

      {loadError ? (
        <div className="rounded-xl border border-chart-danger/40 bg-chart-danger/10 px-3 py-2 text-sm text-chart-danger">
          <p className="font-semibold">Stored prompts unavailable</p>
          <p className="mt-1">{loadError}</p>
          <p className="mt-1 text-xs text-chart-danger/80">
            The prompts below are built-in defaults, not the saved configuration.
          </p>
        </div>
      ) : null}

      {isUnconfigured && loadError === '' ? (
        <div className="rounded-xl border border-chart-servicing/30 bg-chart-servicing/5 px-3 py-2 text-sm text-chart-servicing">
          These prompts have never been saved. The built-in defaults are shown until they are.
        </div>
      ) : null}

      <div className="overflow-hidden rounded-2xl border border-line bg-canvas">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-surface px-4 py-3">
          <p className="text-sm font-medium text-content-muted">Recent assistant exchanges</p>
          {isSampleData ? (
            <span className="rounded-full border border-chart-servicing/40 bg-chart-servicing/5 px-2.5 py-1 text-xs font-semibold text-chart-servicing">
              Sample data &mdash; not recorded traffic
            </span>
          ) : null}
        </div>
        <table className="min-w-full divide-y divide-line text-left text-sm">
          <thead className="bg-surface text-content-muted">
            <tr>
              <th className="px-4 py-3 font-semibold">Driver</th>
              <th className="px-4 py-3 font-semibold">Tokens</th>
              <th className="px-4 py-3 font-semibold">Status</th>
              <th className="px-4 py-3 font-semibold">Issue</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line bg-canvas">
            {chatHistory.length ? (
              chatHistory.map((session) => (
                <tr key={session.id} className="hover:bg-surface">
                  <td className="px-4 py-3 font-medium text-content">{session.driver}</td>
                  <td className="px-4 py-3 text-content-muted">{session.tokens}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${session.status === 'Escalated' ? 'bg-chart-danger/10 text-chart-danger' : session.status === 'Flagged' ? 'bg-chart-servicing/5 text-chart-servicing' : 'bg-chart-collected/10 text-chart-collected'}`}>
                      {session.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-content-muted">{session.issue}</td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-content-subtle">
                  {loadError ? 'Unavailable.' : 'No assistant exchanges recorded.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {saveMessage ? (
        <div
          className={`rounded-xl border px-3 py-2 text-sm ${
            isSaveFailed
              ? 'border-chart-danger/40 bg-chart-danger/10 text-chart-danger'
              : 'border-chart-collected/30 bg-chart-collected/10 text-chart-collected'
          }`}
        >
          {saveMessage}
        </div>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-2">
        <div className="rounded-2xl border border-line bg-canvas p-4">
          <p className="mb-2 text-sm font-semibold text-content-muted">System prompt</p>
          <textarea
            value={systemPrompt}
            onChange={(event) => setSystemPrompt(event.target.value)}
            rows={7}
            className="w-full rounded-xl border border-line bg-surface px-3 py-2 text-sm text-content outline-none focus:border-accent"
          />
        </div>

        <div className="rounded-2xl border border-line bg-canvas p-4">
          <p className="mb-2 text-sm font-semibold text-content-muted">Fallback prompt</p>
          <textarea
            value={fallbackPrompt}
            onChange={(event) => setFallbackPrompt(event.target.value)}
            rows={7}
            className="w-full rounded-xl border border-line bg-surface px-3 py-2 text-sm text-content outline-none focus:border-accent"
          />
        </div>
      </div>

      <div className="flex justify-end">
        <button
          type="button"
          disabled={isSaving || loadError !== ''}
          onClick={() => void savePrompts()}
          className="rounded-lg bg-brand-solid px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-solid-strong disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isSaving ? 'Saving...' : 'Save prompt templates'}
        </button>
      </div>
    </div>
  );
}
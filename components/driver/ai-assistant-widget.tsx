'use client';

import { useState } from 'react';

import { fetchApiJson } from '@/lib/api-client';

type ChatTurn = {
  role: 'user' | 'assistant';
  text: string;
};

/**
 * Diagnostics returned alongside the reply. Used for the footer so a degraded
 * assistant is visible rather than merely felt.
 */
type AssistantMeta = {
  llm: 'answered' | 'not_configured' | 'error';
  dataGrounded: boolean;
  promptSource: 'database' | 'default' | 'mixed';
  promptSha: string;
  toolsRun: string[];
  caveats: string[];
};

type AssistantResponse = AssistantMeta & { reply?: string };

const quickPrompts = ['Check my balance', 'Upload license help', 'Fleet status', 'Contact CEO'];

export function AIAssistantWidget() {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<ChatTurn[]>([
    {
      role: 'assistant',
      text: 'Hi! Ask me about your remittances, document approvals, or fleet status. My answers come straight from the live database.',
    },
  ]);
  const [isLoading, setIsLoading] = useState(false);
  const [meta, setMeta] = useState<AssistantMeta | null>(null);
  const [error, setError] = useState<string | null>(null);

  const askAssistant = async (value?: string) => {
    const userText = (value ?? input).trim();
    if (!userText) return;

    // History is captured before this turn is appended, so the model receives the
    // prior turns without the current question duplicated in two roles.
    const history = messages
      .slice(-6)
      .map((turn) => ({ role: turn.role, text: turn.text }));

    setMessages((current) => [...current, { role: 'user', text: userText }]);
    setInput('');
    setIsLoading(true);
    setError(null);

    // Goes through `fetchApiJson` rather than a bare `fetch`: a 503 from a dead
    // database used to be indistinguishable from success here, and the user saw
    // a plausible answer with no figures in it.
    const result = await fetchApiJson<AssistantResponse>('/api/ai-assistant', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ message: userText, history }),
    });

    setIsLoading(false);

    if (!result.ok) {
      setMeta(null);
      setError(result.message);
      setMessages((current) => [
        ...current,
        { role: 'assistant', text: `I could not reach the fleet data just now. ${result.message}` },
      ]);
      return;
    }

    const { reply, ...diagnostics } = result.data;
    setMeta(diagnostics);
    setMessages((current) => [
      ...current,
      { role: 'assistant', text: reply?.trim() || 'I could not find an answer for that.' },
    ]);
  };

  return (
    <div className="fixed bottom-5 right-5 z-50">
      <div
        className={`transition-all duration-300 ${open ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-4 opacity-0'}`}
      >
        <div className="mb-4 w-[360px] overflow-hidden rounded-[28px] border border-line bg-surface/90 shadow-[0_30px_70px_rgba(15,23,42,0.22)] backdrop-blur-xl">
          <div className="flex items-center justify-between bg-gradient-to-r from-canvas to-surface px-4 py-3 text-content">
            <div className="flex items-center gap-3">
              <div className="relative flex h-3 w-3 items-center justify-center">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#FF4E42] opacity-75" />
                <span className="relative inline-block h-2.5 w-2.5 rounded-full bg-[#FF8F3D]" />
              </div>
              <div>
                <p className="text-sm font-semibold">AI Support</p>
                <p className="text-[10px] uppercase tracking-[0.15em] text-content-subtle">
                  {isLoading ? 'Checking live data' : 'Live fleet data'}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-sm text-content-muted transition hover:text-content focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              Close
            </button>
          </div>

          <div className="bg-surface-2 p-3">
            <div className="mb-3 flex flex-wrap gap-2">
              {quickPrompts.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  onClick={() => void askAssistant(prompt)}
                  disabled={isLoading}
                  className="rounded-full border border-line bg-surface px-2.5 py-1.5 text-[11px] font-medium text-content transition hover:border-accent/60 hover:text-accent disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {prompt}
                </button>
              ))}
            </div>

            <div className="max-h-72 space-y-3 overflow-y-auto rounded-2xl bg-surface p-3 shadow-inner">
              {messages.map((message, index) => (
                <div
                  key={`${message.role}-${index}`}
                  className={`max-w-[85%] whitespace-pre-line rounded-2xl px-3 py-2 text-sm leading-6 ${
                    message.role === 'assistant'
                      ? 'bg-surface-2 text-content'
                      : 'ml-auto bg-brand-solid text-white shadow-[0_0_12px_rgba(255,78,66,0.35)]'
                  }`}
                >
                  {message.text}
                </div>
              ))}
            </div>

            {/*
              Provenance line. Without it the user cannot tell a real database
              answer from a canned one, which is the whole difference between the
              assistant being trustworthy and looking plausible.
            */}
            {error ? (
              <p className="mt-2 rounded-xl border border-chart-danger/30 bg-chart-danger/10 px-3 py-2 text-[11px] leading-5 text-chart-danger">
                {error}
              </p>
            ) : meta ? (
              <div className="mt-2 rounded-xl border border-line bg-surface px-3 py-2 text-[11px] leading-5 text-content-subtle">
                <p>
                  {meta.dataGrounded ? 'Answered from live records' : 'No matching records'}
                  {' · '}
                  {meta.llm === 'answered'
                    ? 'written by the configured model'
                    : meta.llm === 'not_configured'
                      ? 'no model configured, figures quoted directly'
                      : 'model unavailable, figures quoted directly'}
                </p>
                <p className="text-content-subtle">
                  Prompt{' '}
                  {meta.promptSource === 'database' ? 'from Developer portal' : 'using built-in default'}
                  {' · '}
                  <code className="font-mono">#{meta.promptSha}</code>
                </p>
                {meta.caveats.length > 0 ? (
                  <p className="mt-1 text-content-subtle">{meta.caveats.join(' ')}</p>
                ) : null}
              </div>
            ) : null}
          </div>

          <div className="flex gap-2 border-t border-line bg-surface p-3">
            <input
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !isLoading) {
                  event.preventDefault();
                  void askAssistant();
                }
              }}
              placeholder="Ask about payments, documents or fleet status..."
              aria-label="Message the AI assistant"
              className="flex-1 rounded-xl border border-line bg-surface-2 px-3 py-2.5 text-sm text-content outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
            />
            <button
              type="button"
              onClick={() => void askAssistant()}
              disabled={isLoading}
              className="rounded-xl bg-brand-solid px-4 py-2.5 text-sm font-semibold text-white shadow-[0_0_12px_rgba(255,78,66,0.35)] transition hover:bg-brand-solid-strong disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isLoading ? '...' : 'Send'}
            </button>
          </div>
        </div>
      </div>

      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="relative flex h-16 w-16 items-center justify-center rounded-full bg-brand-solid text-2xl text-white shadow-[0_0_18px_rgba(255,78,66,0.4)] transition hover:scale-105"
        aria-label="Open AI Assistant"
      >
        <span className="absolute -top-1 -right-1 inline-flex h-4 w-4 items-center justify-center rounded-full border-2 border-white bg-[#FF8F3D]" />
        ✦
      </button>
    </div>
  );
}
'use client';

import { useEffect, useState } from 'react';
import { createSupabaseClient } from '@/lib/supabase/client';

type ChatMessage = {
  id: string;
  sender_id: string;
  receiver_id: string;
  content: string;
  created_at: string;
};

const INITIAL_DRIVERS = ['Driver A', 'Driver B', 'Driver C'];

export function CEOChatPanel() {
  const [driverName, setDriverName] = useState(INITIAL_DRIVERS[0]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [userId, setUserId] = useState<string | null>(null);

  useEffect(() => {
    const supabase = createSupabaseClient();

    async function initialize() {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) return;
      setUserId(user.id);

      const { data, error } = await supabase.from('messages')
        .select('*')
        .or(`sender_id.eq.${user.id},receiver_id.eq.${user.id}`)
        .order('created_at', { ascending: true });

      if (!error && data) {
        setMessages(data);
      }

      const channel = supabase
        .channel('ceo-driver-chat')
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'messages' },
          (payload) => {
            const incoming = payload.new as ChatMessage;
            if (incoming.receiver_id === user.id || incoming.sender_id === user.id) {
              setMessages((current) => [...current, incoming]);
            }
          }
        )
        .subscribe();

      return () => {
        supabase.removeChannel(channel);
      };
    }

    void initialize();
  }, []);

  const sendReply = async () => {
    if (!draft.trim() || !userId) return;

    const supabase = createSupabaseClient();
    const selectedDriverId = process.env.NEXT_PUBLIC_DRIVER_USER_ID ?? '11111111-1111-1111-1111-111111111111';

    const { error } = await supabase.from('messages').insert({
      sender_id: userId,
      receiver_id: selectedDriverId,
      content: draft.trim(),
    });

    if (!error) {
      setDraft('');
    }
  };

  return (
    <div className="card">
      <div className="mb-5 flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-content-subtle">Direct support</p>
          <h2 className="mt-1 text-2xl font-bold text-content">Driver communication</h2>
        </div>
        <select
          value={driverName}
          onChange={(event) => setDriverName(event.target.value)}
          className="rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-content-muted outline-none focus:border-accent"
        >
          {INITIAL_DRIVERS.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </div>

      <div className="mb-4 max-h-80 space-y-3 overflow-y-auto rounded-xl border border-line bg-surface-2 p-3">
        {messages.length ? (
          messages.map((message) => {
            const isMine = message.sender_id === userId;

            return (
              <div
                key={message.id}
                className={`max-w-[80%] rounded-xl px-3 py-2 text-sm ${
                  isMine ? 'ml-auto bg-brand-solid text-white' : 'bg-surface text-white-muted'
                }`}
              >
                <p>{message.content}</p>
                <p className={`mt-1 text-[10px] ${isMine ? 'text-brand-100' : 'text-content-subtle'}`}>
                  {new Date(message.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </p>
              </div>
            );
          })
        ) : (
          <div className="text-sm text-content-subtle">No messages for {driverName} yet.</div>
        )}
      </div>

      <div className="flex gap-2">
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={`Reply to ${driverName}...`}
          className="flex-1 rounded-lg border border-line bg-surface-2 px-3 py-2.5 text-sm text-content outline-none transition focus:border-accent focus:ring-2 focus:ring-brand-100"
        />
        <button
          type="button"
          onClick={() => void sendReply()}
          className="rounded-lg bg-brand-solid px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-solid-strong"
        >
          Reply
        </button>
      </div>
    </div>
  );
}

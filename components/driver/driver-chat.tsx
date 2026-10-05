'use client';

import { useEffect, useState } from 'react';
import { createSupabaseClient } from '@/lib/supabase/client';

type MessageRow = {
  id: string;
  sender_id: string;
  receiver_id: string;
  content: string;
  created_at: string;
};

const CEO_ID = process.env.NEXT_PUBLIC_CEO_USER_ID ?? '00000000-0000-0000-0000-000000000000';

export function DriverChat() {
  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [draft, setDraft] = useState('');
  const [userId, setUserId] = useState<string | null>(null);

  useEffect(() => {
    const supabase = createSupabaseClient();
    let isMounted = true;

    async function initialize() {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user || !isMounted) return;

      setUserId(user.id);

      const { data, error } = await supabase.from('messages')
        .select('*')
        .or(`sender_id.eq.${user.id},receiver_id.eq.${user.id}`)
        .order('created_at', { ascending: true });

      if (!error && data) {
        setMessages(data);
      }

      const channel = supabase
        .channel('driver-ceo-chat')
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'messages' },
          (payload) => {
            const nextMessage = payload.new as MessageRow;
            if (
              (nextMessage.sender_id === user.id || nextMessage.receiver_id === user.id) &&
              (nextMessage.sender_id === CEO_ID || nextMessage.receiver_id === CEO_ID)
            ) {
              setMessages((current) => [...current, nextMessage]);
            }
          }
        )
        .subscribe();

      return () => {
        supabase.removeChannel(channel);
      };
    }

    const unsubscribe = initialize();

    return () => {
      isMounted = false;
      void unsubscribe;
    };
  }, []);

  const sendMessage = async () => {
    if (!draft.trim() || !userId) return;

    const supabase = createSupabaseClient();
    const { error } = await supabase.from('messages').insert({
      sender_id: userId,
      receiver_id: CEO_ID,
      content: draft.trim(),
    });

    if (!error) {
      setDraft('');
    }
  };

  return (
    <div className="card">
      <div className="mb-5">
        <p className="text-sm font-medium text-content-subtle">Direct communication</p>
        <h2 className="mt-1 text-2xl font-bold text-content">Chat with CEO</h2>
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
          <div className="text-sm text-content-subtle">No messages yet. Start the conversation with the CEO.</div>
        )}
      </div>

      <div className="flex gap-2">
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Write a message..."
          className="flex-1 rounded-lg border border-line bg-surface-2 px-3 py-2.5 text-sm text-content outline-none transition focus:border-accent focus:ring-2 focus:ring-brand-100"
        />
        <button
          type="button"
          onClick={() => void sendMessage()}
          className="rounded-lg bg-brand-solid px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-solid-strong"
        >
          Send
        </button>
      </div>
    </div>
  );
}

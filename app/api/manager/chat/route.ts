import { NextResponse } from 'next/server';

import { badRequestResponse, databaseErrorResponse } from '@/lib/api-errors';
import { authorizeRole } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const ALLOWED_ROLES = ['manager'];

export async function GET() {
  const auth = await authorizeRole(ALLOWED_ROLES);

  if (!auth.authorized) {
    return auth.response;
  }

  try {
    const { data, error } = await auth.supabase
      .from('messages')
      .select('id, sender_id, receiver_id, content, created_at')
      .or(`sender_id.eq.${auth.user.id},receiver_id.eq.${auth.user.id}`)
      .order('created_at', { ascending: false })
      .limit(20);

    if (error) {
      return databaseErrorResponse(error, 'load chat messages');
    }

    const rows = (data ?? []) as Array<Record<string, any>>;

    return NextResponse.json({
      messages: rows.map((row) => ({
        id: String(row.id),
        // Scoped to the authenticated caller instead of echoing a raw UUID.
        sender: row.sender_id === auth.user.id ? 'manager' : 'ceo',
        content: String(row.content ?? ''),
        createdAt: new Date(row.created_at ?? Date.now()).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
        }),
      })),
      /** Distinguishes "queried fine, no messages yet" from a failed load. */
      empty: { messages: rows.length === 0 },
    });
  } catch {
    return databaseErrorResponse(new Error('chat request failed unexpectedly'), 'load chat messages');
  }
}

export async function POST(request: Request) {
  const auth = await authorizeRole(ALLOWED_ROLES);

  if (!auth.authorized) {
    return auth.response;
  }

  try {
    const body = await request.json();
    const content = body?.content as string | undefined;

    if (!content || !content.trim()) {
      return badRequestResponse('Message content is required.');
    }

    // The sender is always the authenticated caller; it is never client-supplied.
    const senderId = auth.user.id;

    const { data: ceoProfile, error: ceoLookupError } = await auth.supabase
      .from('profiles')
      .select('id')
      .eq('role', 'ceo')
      .limit(1)
      .maybeSingle();

    if (ceoLookupError) {
      return databaseErrorResponse(ceoLookupError, 'look up the CEO account to address');
    }

    if (!ceoProfile) {
      return NextResponse.json(
        { success: false, message: 'No CEO account is configured to receive messages.' },
        { status: 409 }
      );
    }

    const { data, error } = await auth.supabase
      .from('messages')
      .insert({
        sender_id: senderId,
        receiver_id: ceoProfile.id,
        content: content.trim(),
      })
      .select('id, content, created_at')
      .single();

    if (error) {
      return databaseErrorResponse(error, 'insert chat message');
    }

    return NextResponse.json({
      success: true,
      message: {
        id: String(data?.id ?? `msg-${Date.now()}`),
        sender: 'manager',
        content: String(data?.content ?? content.trim()),
        createdAt: new Date(data?.created_at ?? Date.now()).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
        }),
      },
    });
  } catch {
    return databaseErrorResponse(new Error('send message failed unexpectedly'), 'insert chat message');
  }
}
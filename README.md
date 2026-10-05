# Astar Travels App

A fleet management and driver remittance SaaS platform built with Next.js 14, Supabase, Tailwind CSS, and shadcn/ui.

## Quick start

1. Copy `.env.example` to `.env.local` and add your Supabase project credentials.
2. Run `npm install`.
3. Run `npm run dev`.

## Core access roles

- CEO: financial dashboard, fleet oversight, payouts, document review, and driver communication.
- Driver: remittance management, document upload, and direct chat.
- Developer: system diagnostics, metadata access, and role override workflows.

## Database

Use the SQL in `supabase/schema.sql` to initialize the schema and RLS policies.

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string;
          email: string;
          full_name: string | null;
          role: 'driver' | 'ceo' | 'manager' | 'developer' | 'suspended';
          phone: string | null;
          created_at: string;
          /** Account state, separate from `role`. See baseline.sql section 2. */
          status: 'active' | 'pending' | 'suspended';
          /** Object key in the private `avatars` bucket, not a URL. */
          driver_profile_photo_path: string | null;
        };
        Insert: {
          id: string;
          email: string;
          full_name?: string | null;
          role?: 'driver' | 'ceo' | 'manager' | 'developer' | 'suspended';
          phone?: string | null;
          created_at?: string;
          status?: 'active' | 'pending' | 'suspended';
          driver_profile_photo_path?: string | null;
        };
        Update: {
          id?: string;
          email?: string;
          full_name?: string | null;
          role?: 'driver' | 'ceo' | 'manager' | 'developer' | 'suspended';
          phone?: string | null;
          created_at?: string;
          status?: 'active' | 'pending' | 'suspended';
          driver_profile_photo_path?: string | null;
        };
        Relationships: [],
      };
      driver_documents: {
        Row: {
          id: string;
          driver_id: string;
          document_type: string;
          /** Legacy permanent URL. Nullable: new rows store `storage_path` instead. */
          document_url: string | null;
          /** Object key inside `storage_bucket`, e.g. `<driver_id>/passport-1.pdf`. */
          storage_path: string | null;
          storage_bucket: string | null;
          status: 'pending' | 'approved' | 'rejected' | 'action_required';
          uploaded_at: string;
        };
        Insert: {
          id?: string;
          driver_id: string;
          document_type: string;
          document_url?: string | null;
          storage_path?: string | null;
          storage_bucket?: string | null;
          status?: 'pending' | 'approved' | 'rejected' | 'action_required';
          uploaded_at?: string;
        };
        Update: {
          id?: string;
          driver_id?: string;
          document_type?: string;
          document_url?: string | null;
          storage_path?: string | null;
          storage_bucket?: string | null;
          status?: 'pending' | 'approved' | 'rejected' | 'action_required';
          uploaded_at?: string;
        };
        Relationships: [];
      };
      system_config: {
        Row: {
          key: string;
          value: Json;
          updated_at: string;
        };
        Insert: {
          key: string;
          value?: Json;
          updated_at?: string;
        };
        Update: {
          key?: string;
          value?: Json;
          updated_at?: string;
        };
        Relationships: [],
      };
      cars: {
        Row: {
          id: string;
          /** Nullable: unfinished multi-tenancy column, never populated. See baseline.sql section 2. */
          company_id: string | null;
          registration_number: string;
          model: string;
          year: number;
          status: 'active' | 'servicing' | 'inactive';
          daily_rate: number;
          created_at: string;
        };
        Insert: {
          id?: string;
          company_id?: string | null;
          registration_number: string;
          model: string;
          year: number;
          status?: 'active' | 'servicing' | 'inactive';
          daily_rate: number;
          created_at?: string;
        };
        Update: {
          id?: string;
          company_id?: string | null;
          registration_number?: string;
          model?: string;
          year?: number;
          status?: 'active' | 'servicing' | 'inactive';
          daily_rate?: number;
          created_at?: string;
        };
        Relationships: [],
      };
      daily_remittances: {
        Row: {
          id: string;
          driver_id: string;
          car_id: string;
          amount: number;
          status: 'pending' | 'paid' | 'overdue';
          payment_reference: string | null;
          payment_date: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          driver_id: string;
          car_id: string;
          amount: number;
          status?: 'pending' | 'paid' | 'overdue';
          payment_reference?: string | null;
          payment_date?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          driver_id?: string;
          car_id?: string;
          amount?: number;
          status?: 'pending' | 'paid' | 'overdue';
          payment_reference?: string | null;
          payment_date?: string | null;
          created_at?: string;
        };
        Relationships: [],
      };
      driver_onboarding_queue: {
        Row: {
          id: string;
          manager_id: string | null;
          full_name: string;
          phone: string;
          national_id: string;
          driving_license_number: string;
          assigned_car: string | null;
          daily_remittance_target: number;
          verification_status: 'auto_verified' | 'needs_manual_review';
          setup_email: string | null;
          setup_link: string | null;
          status: 'pending' | 'approved' | 'rejected' | 'provisioned';
          created_at: string;
          reviewed_at: string | null;
          /** Nullable: a candidate may have no account yet. */
          driver_id: string | null;
          national_id_storage_path: string | null;
          driving_license_storage_path: string | null;
          rejection_reason: string | null;
        };
        Insert: {
          id?: string;
          manager_id?: string | null;
          full_name: string;
          phone: string;
          national_id: string;
          driving_license_number: string;
          assigned_car?: string | null;
          daily_remittance_target?: number;
          verification_status?: 'auto_verified' | 'needs_manual_review';
          setup_email?: string | null;
          setup_link?: string | null;
          status?: 'pending' | 'approved' | 'rejected' | 'provisioned';
          created_at?: string;
          reviewed_at?: string | null;
          driver_id?: string | null;
          national_id_storage_path?: string | null;
          driving_license_storage_path?: string | null;
          rejection_reason?: string | null;
        };
        Update: {
          id?: string;
          manager_id?: string | null;
          full_name?: string;
          phone?: string;
          national_id?: string;
          driving_license_number?: string;
          assigned_car?: string | null;
          daily_remittance_target?: number;
          verification_status?: 'auto_verified' | 'needs_manual_review';
          setup_email?: string | null;
          setup_link?: string | null;
          status?: 'pending' | 'approved' | 'rejected' | 'provisioned';
          created_at?: string;
          reviewed_at?: string | null;
          driver_id?: string | null;
          national_id_storage_path?: string | null;
          driving_license_storage_path?: string | null;
          rejection_reason?: string | null;
        };
        Relationships: [],
      };
      driver_payouts: {
        Row: {
          id: string;
          driver_id: string;
          amount: number;
          payout_type: string;
          status: 'queued' | 'processed' | 'review';
          transaction_reference: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          driver_id: string;
          amount: number;
          payout_type: string;
          status?: 'queued' | 'processed' | 'review';
          transaction_reference?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          driver_id?: string;
          amount?: number;
          payout_type?: string;
          status?: 'queued' | 'processed' | 'review';
          transaction_reference?: string | null;
          created_at?: string;
        };
        Relationships: [],
      };
      vehicle_maintenance: {
        Row: {
          id: string;
          vehicle_registration: string;
          issue_summary: string;
          estimated_cost: number;
          priority: 'high' | 'medium' | 'low';
          status: 'open' | 'scheduled' | 'completed';
          created_at: string;
        };
        Insert: {
          id?: string;
          vehicle_registration: string;
          issue_summary: string;
          estimated_cost?: number;
          priority?: 'high' | 'medium' | 'low';
          status?: 'open' | 'scheduled' | 'completed';
          created_at?: string;
        };
        Update: {
          id?: string;
          vehicle_registration?: string;
          issue_summary?: string;
          estimated_cost?: number;
          priority?: 'high' | 'medium' | 'low';
          status?: 'open' | 'scheduled' | 'completed';
          created_at?: string;
        };
        Relationships: [],
      };
      messages: {
        Row: {
          id: string;
          sender_id: string;
          receiver_id: string;
          content: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          sender_id: string;
          receiver_id: string;
          content: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          sender_id?: string;
          receiver_id?: string;
          content?: string;
          created_at?: string;
        };
        Relationships: [],
      };
      user_preferences: {
        Row: {
          /**
           * Both the primary key and the foreign key to profiles.id, so a user
           * can only ever have one preferences row and it must be their own.
           */
          user_id: string;
          email_alerts: boolean;
          sms_reminders: boolean;
          /**
           * `'system'` is stored verbatim rather than expanded to whichever
           * scheme happened to be active, so the record keeps saying what the
           * user chose instead of freezing one resolution of it.
           */
          theme: 'system' | 'light' | 'dark';
          updated_at: string;
        };
        Insert: {
          user_id: string;
          email_alerts?: boolean;
          sms_reminders?: boolean;
          theme?: 'system' | 'light' | 'dark';
          updated_at?: string;
        };
        Update: {
          email_alerts?: boolean;
          sms_reminders?: boolean;
          theme?: 'system' | 'light' | 'dark';
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'user_preferences_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: true;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
    };
    Views: {
      [_ in never]: never;
    };
    /**
     * Declared by hand rather than left as `[_ in never]: never`, because these
     * three exist in supabase/baseline.sql and were already callable -- they were
     * simply not written down here, which made `.rpc('is_role', ...)` a compile
     * error and pushed callers toward casting the client to `any` to get at them.
     *
     * Each returns a single `jsonb` value, so PostgREST hands it back as a
     * one-element array; the call sites unwrap `data[0]` rather than expecting an
     * object.
     *
     * `developer_*` are the health-panel functions. They are absent from a
     * project that has not applied
     * supabase/migrations/20261005_developer_health_introspection.sql, which
     * surfaces at runtime as PostgREST error PGRST202 rather than as a type error.
     * The health route treats that code as "not applied yet" and falls back.
     */
    Functions: {
      /**
       * Role predicate used by every RLS policy in the schema.
       *
       * `app_role` is spelled out as a union rather than referenced through
       * `Database['public']['Enums']` because this generated type declares no
       * `Enums` block -- it is hand-maintained, so a reference to a section that
       * does not exist would be the only thing breaking every `.rpc('is_role')`
       * call.
       */
      is_role: {
        Args: { target_role: 'driver' | 'ceo' | 'manager' | 'developer' | 'suspended' };
        Returns: boolean;
      };
      /**
       * Trigger functions. They are declared because `supabase-js` requires the
       * name to be a known key, but they are `returns trigger` and are never
       * invoked over RPC -- the triggers in baseline.sql call them directly.
       */
      handle_new_user: {
        Args: Record<PropertyKey, never>;
        Returns: TriggerReturn;
      };
      guard_profile_role_change: {
        Args: Record<PropertyKey, never>;
        Returns: TriggerReturn;
      };
      developer_rls_policy_counts: {
        Args: Record<PropertyKey, never>;
        Returns: Json;
      };
      developer_storage_inventory: {
        Args: Record<PropertyKey, never>;
        Returns: Json;
      };
      developer_table_counts: {
        Args: Record<PropertyKey, never>;
        Returns: Json;
      };
      /**
       * Postgres backend counts from `pg_stat_activity`, plus `max_connections`.
       *
       * Returns a single `jsonb`, so PostgREST hands it back nested under the
       * function name; the route unwraps that with `unwrapJsonMap()`.
       */
      developer_connection_counts: {
        Args: Record<PropertyKey, never>;
        Returns: Json;
      };
    };
  };
};

/**
 * What a Postgres trigger function resolves to.
 *
 * `supabase-js` has no trigger return type, so this is the conventional stand-in:
 * a trigger function called over RPC returns the string `'TRIGGER'`, and
 * modelling it as `unknown` is more honest than claiming `void` -- nothing is
 * returned to a client in any case, because nothing calls these over RPC.
 */
export type TriggerReturn = unknown;

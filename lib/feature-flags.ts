/**
 * Canonical definitions for the operator-controlled feature flags.
 *
 * These were duplicated: the API route carried three flags and the panel carried
 * four, so `GET /api/developer/config` was silently dropping
 * `pause_payment_webhooks` and `driver_verification_gate` from the UI on every
 * load. Both the route and the panel now import this single list, so adding a
 * flag is a one-line change that cannot drift again.
 *
 * `label`, `description` and `defaultValue` are presentation and bootstrap
 * metadata held in code. The *authoritative* on/off state lives in the
 * `system_config` table under `key`, and that is what the API reads.
 */
export type FeatureFlagDefinition = {
  key: string;
  label: string;
  description: string;
  /**
   * Used only until a row exists in `system_config`. Once the operator saves,
   * the database value wins and this is never consulted again.
   */
  defaultValue: boolean;
};

export const FEATURE_FLAG_DEFINITIONS: FeatureFlagDefinition[] = [
  {
    key: 'maintenance_mode',
    label: 'Maintenance Mode',
    description: 'Block non-essential customer actions during maintenance.',
    defaultValue: false,
  },
  {
    key: 'pause_payment_webhooks',
    label: 'Pause Payment Webhooks',
    description: 'Temporarily suspend automatic Daraja and Paystack webhook processing.',
    defaultValue: false,
  },
  {
    key: 'ai_chatbot_enabled',
    label: 'AI Chatbot Enabled',
    description: 'Allow driver access to the support assistant and prompt engine.',
    defaultValue: true,
  },
  {
    key: 'driver_verification_gate',
    label: 'Verification Gate',
    description: 'Require manager approval before onboarding new driver documents.',
    defaultValue: true,
  },
];

export const FEATURE_FLAG_KEYS = FEATURE_FLAG_DEFINITIONS.map((flag) => flag.key);
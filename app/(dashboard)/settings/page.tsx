import type { Metadata } from 'next';

import { ProfileSettings } from '@/components/settings/profile-settings';

/**
 * Settings fallback for any route that is not one of the four portals.
 *
 * Reached when the header's derived link cannot identify a portal — for instance
 * on this page itself, whose own path is `/settings`. It renders the same panel
 * inside the same shared header rather than a 404, so the Settings link is never
 * a dead end. The four portal-specific routes at `/ceo/settings`, `/manager/settings`,
 * `/developer/settings` and `/driver/settings` render this same component.
 */
export const metadata: Metadata = {
  title: 'Profile & Settings',
  description: 'Manage your account details, password and notification preferences.',
};

export default function SettingsPage() {
  return <ProfileSettings />;
}
import type { Metadata } from 'next';

import { FacePhotoUpload } from '@/components/driver/face-photo-upload';
import { ProfileSettings } from '@/components/settings/profile-settings';

/**
 * driver portal settings.
 *
 * Thin route on purpose: the panel is shared by all four portals, so the field
 * whitelist, the password rules and the preferences fallback have one
 * implementation rather than four that can drift apart on a security rule.
 *
 * The route is reachable by any authenticated user of this portal. The panel
 * itself is not role-gated, because every role has a profile and a password —
 * gating it to ceo/manager would deny the driver and developer portals the one
 * screen they most need.
 */
export const metadata: Metadata = {
  title: 'Profile & Settings',
  description: 'Manage your account details, password and notification preferences.',
};

export default function DriverSettingsPage() {
  return (
    <div className="space-y-6">
      {/*
        The face photo is a separate card rather than another field inside
        ProfileSettings. That panel edits `profiles` columns through a single
        whitelisted PATCH (`full_name`, `phone`); a photo is a file upload against
        a different endpoint with different validation, and folding it in would
        mean two save paths, two error surfaces and two pending states behind one
        "Save" button.
      */}
      <FacePhotoUpload />
      <ProfileSettings />
    </div>
  );
}

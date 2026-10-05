import { redirect } from 'next/navigation';

/**
 * `/manager/vehicles` → `/fleet`.
 *
 * Fleet data is editable by manager, CEO and developer, and the middleware guards
 * each portal prefix by role. A page living under `/manager` is therefore
 * unreachable for the other two, no matter what its own route guard says. The real
 * interface lives at `/fleet`, which all three roles are admitted to.
 *
 * This redirect exists so the manager-facing path still works and still lands on
 * the real fleet interface, rather than 403-ing for the manager who is most likely
 * to be typing it.
 */
export default function ManagerVehiclesRedirect() {
  redirect('/fleet');
}
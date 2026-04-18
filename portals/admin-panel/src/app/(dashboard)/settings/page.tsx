import { getSession } from "@/lib/auth";

export default async function SettingsPage() {
  const session = await getSession();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Settings</h1>
        <p className="text-gray-600">Configure admin panel settings</p>
      </div>

      <div className="bg-white rounded-xl shadow-sm p-6 max-w-2xl">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Your Profile</h2>

        <dl className="space-y-4">
          <div>
            <dt className="text-sm font-medium text-gray-500">Name</dt>
            <dd className="mt-1 text-sm text-gray-900">{session?.name}</dd>
          </div>
          <div>
            <dt className="text-sm font-medium text-gray-500">Email</dt>
            <dd className="mt-1 text-sm text-gray-900">{session?.email}</dd>
          </div>
          <div>
            <dt className="text-sm font-medium text-gray-500">Role</dt>
            <dd className="mt-1">
              <span className="px-2 py-1 text-xs font-medium rounded-full bg-primary-100 text-primary-800 capitalize">
                {session?.role.replace("_", " ")}
              </span>
            </dd>
          </div>
          <div>
            <dt className="text-sm font-medium text-gray-500">Permissions</dt>
            <dd className="mt-1 flex flex-wrap gap-2">
              {session?.role === "super_admin" ? (
                <span className="px-2 py-1 text-xs font-medium rounded-full bg-green-100 text-green-800">
                  All Permissions
                </span>
              ) : (
                session?.permissions.map((perm) => (
                  <span
                    key={perm}
                    className="px-2 py-1 text-xs font-medium rounded-full bg-gray-100 text-gray-800"
                  >
                    {perm}
                  </span>
                ))
              )}
            </dd>
          </div>
        </dl>
      </div>

      <div className="bg-white rounded-xl shadow-sm p-6 max-w-2xl">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Store Configuration</h2>
        <p className="text-sm text-gray-500">
          Store configuration is managed through environment variables and the Convex dashboard.
        </p>
        <div className="mt-4 p-4 bg-gray-50 rounded-lg">
          <p className="text-sm font-mono text-gray-600">
            NEXT_PUBLIC_CONVEX_URL={process.env.NEXT_PUBLIC_CONVEX_URL}
          </p>
        </div>
      </div>
    </div>
  );
}

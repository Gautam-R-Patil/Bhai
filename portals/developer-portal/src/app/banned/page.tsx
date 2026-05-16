import { cookies } from "next/headers";

// F14d: terminal page for banned/suspended developers. The dashboard layout
// re-fetches the developer's status from Convex on every page load and
// redirects here if banned or suspended. Their cookie is cleared so they
// have to re-authenticate (and they'll be blocked at login if their status
// still says banned/suspended).
export default async function BannedPage() {
  const cookieStore = await cookies();
  cookieStore.delete("dev_session");

  return (
    <main className="min-h-screen flex items-center justify-center p-8 bg-gray-50">
      <div className="max-w-md w-full bg-white rounded-2xl shadow-sm border border-gray-200 p-10 text-center">
        <h1 className="text-2xl font-semibold text-gray-900 mb-3">Account suspended</h1>
        <p className="text-gray-600 mb-6">
          Your developer account is no longer active. If you believe this is a mistake,
          contact support at <a className="text-primary-600 underline" href="mailto:support@tryatlasagi.com">support@tryatlasagi.com</a>.
        </p>
      </div>
    </main>
  );
}

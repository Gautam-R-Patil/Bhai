# Bhai Store Admin Panel

Admin dashboard for managing the Bhai Store - developers, app submissions, and users.

## Setup

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Configure environment:**
   ```bash
   cp .env.example .env.local
   ```

   Edit `.env.local`:
   - `NEXT_PUBLIC_CONVEX_URL` - Your Convex deployment URL
   - `JWT_SECRET` - Generate a random 64-character string
   - `INITIAL_ADMIN_EMAIL` - Email for the first admin account
   - `INITIAL_ADMIN_PASSWORD` - Password for the first admin account
   - `BHAI_ADMIN_KEY` (server-side only) - must match `ADMIN_API_KEY` in Convex; `NEXT_PUBLIC_BHAI_ADMIN_API_BASE` optional (the old `ATLAS_` names still work)
   - `ATLAS_MCP_CONVEX_SITE_URL` + `ATLAS_MCP_ADMIN_KEY` (server-side only) - for the Enterprise page

3. **Create initial admin:**
   ```bash
   # After running the app, call the setup endpoint once:
   curl -X POST http://localhost:3000/api/auth/setup
   ```

4. **Run development server:**
   ```bash
   npm run dev
   ```

5. **Build for production:**
   ```bash
   npm run build
   ```

Tests: `npm test` (vitest).

## Deployment to Hostinger

1. Build the project:
   ```bash
   npm run build
   ```

2. Upload the following to Hostinger:
   - `.next/` folder
   - `node_modules/` folder
   - `package.json`
   - `next.config.js`

3. Set environment variables in Hostinger's Node.js settings

4. Start with: `npm start`

**Or use the standalone build:**
```bash
npm run build
# Upload .next/standalone folder
# Set NODE_ENV=production
# Run: node .next/standalone/server.js
```

## Features

- **Dashboard** - Overview stats and pending items
- **Users** - Bhai accounts
- **Waitlist** / **Contact** - Waitlist signups (resend invite) and contact-form messages
- **Enterprise** - Bhai Tools MCP customer licenses and usage (isolated enterprise Convex deployment)
- **LLM logs** / **Error logs** - Observability (admin-gated Convex httpActions)
- **Developers** - Approve/reject developer accounts
- **Submissions** - Review and approve app submissions
- **Apps** - Manage published apps, feature/unfeature
- **Activity** - View all store activity logs
- **Settings** - Admin profile settings
- **Admins** - Manage admin accounts (super_admin only)

## Admin Roles

| Role | Permissions |
|------|-------------|
| `super_admin` | Full access |
| `moderator` | Approve devs, review apps, manage users |
| `reviewer` | Review apps only |

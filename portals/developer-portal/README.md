# A.T.L.A.S Developer Portal

Web portal for developers to register, create, and publish Skills, MCP Servers, and Tools for the A.T.L.A.S Store.

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

3. **Run development server:**
   ```bash
   npm run dev
   ```

   The portal runs on port 3001 by default (admin is on 3000).

4. **Build for production:**
   ```bash
   npm run build
   ```

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

## Features

### Public Pages
- **Home** - Landing page with info about developing for A.T.L.A.S
- **Login** - Developer sign in
- **Register** - Create developer account

### Dashboard (After Approval)
- **Overview** - Stats and recent activity
- **My Apps** - Published apps management
- **Submissions** - Track submission status
- **Analytics** - Install and rating stats
- **Settings** - Profile management

## Developer Workflow

1. **Register** - Create account with profile info
2. **Wait for Approval** - Admin reviews and approves
3. **Create Submission** - Upload Skill, MCP Server, or Tool
4. **Review** - Admin reviews submission
5. **Published** - Appears in A.T.L.A.S Store

## App Types

| Type | Description | Format |
|------|-------------|--------|
| Skill | Instruction sets in Markdown | Single `.md` file |
| MCP Server | Model Context Protocol servers | ZIP with Node.js code |
| Tool | Custom TypeScript tools | ZIP with handler code |

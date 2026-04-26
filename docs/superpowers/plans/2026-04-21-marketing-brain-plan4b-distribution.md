# Marketing Brain — Plan 4B: Distribution, Outreach & Scheduling

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement cold email/LinkedIn outreach engine, marketing scheduler (posts content at scheduled times autonomously), and remaining platform adapters (Facebook Pages, YouTube Shorts, Reddit, Product Hunt).

**Architecture:** `cold_outreach` tool uses `lead-finder.ts` (Apollo.io) to find prospects, LLM to personalise emails, then sends via existing nodemailer SMTP. `marketing_schedule` tool wraps `schedule_task` cron with platform-optimal timing. Facebook and YouTube reuse the Meta/Google OAuth clients already in the codebase.

**Prereq:** Plans 1–4A complete. Run `npm install snoowrap` before starting.

**Tech Stack:** nodemailer (existing), googleapis (existing for YouTube), Meta Graph API (existing pattern from instagram.ts), snoowrap for Reddit, Product Hunt GraphQL API (fetch), node-cron (existing).

---

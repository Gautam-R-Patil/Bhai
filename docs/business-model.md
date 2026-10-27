# Bhai Business Model Design
**Date:** 2026-04-26  
**Company:** XAGI Labs Private Limited  
**Product:** Bhai v0.2.1 — Autonomous Personal AI Agent  
**Status:** Approved for implementation

---

## 1. Cost Foundation

All pricing is derived from actual model costs in `native/src/model_router.rs` and `convex/http.ts`.

### LLM Model Costs (per call: 12K input tokens, 800 output tokens)

| Model | Credit Tier | Cost/Call | Cost/Credit |
|---|---|---|---|
| Claude Opus 4.6 | Heavy (3 cr) | $0.048 (cached) | $0.016 |
| Claude Sonnet 4.6 | Pro (1 cr) | $0.030 (cached) | $0.030 |
| Gemini 3.1 Pro | Pro (1 cr) | $0.034 | $0.034 |
| Gemini 2.5 Flash | Mid (0.5 cr) | $0.006 | $0.012 |
| Nova Pro | Mid (0.5 cr) | $0.012 | $0.024 |
| Claude Haiku 4.5 | Light (0.25 cr) | $0.011 (cached) | $0.046 |
| Gemini Flash Lite | Light (0.25 cr) | $0.002 | $0.006 |
| Nova Micro | Light (0.25 cr) | $0.001 | $0.002 |

> **Prompt caching note:** `convex/http.ts:296` implements Anthropic cache breakpoints. At 80% cache hit rate on 9K of 12K tokens, Sonnet input cost drops ~50%. This is already live and compounding.

### Blended Cost Per Credit (40% light / 30% mid / 20% pro / 10% heavy mix)

**$0.022/credit** — this is the unit cost that drives all pricing decisions.

### Non-LLM Infrastructure

| Service | Cost |
|---|---|
| Convex backend (LLM proxy, auth, DB) | $25–500/mo depending on scale |
| Web hosting (tryatlasagi.com, portals) | $0–20/mo |
| OTPless (auth), monitoring, domain | ~$30/mo |
| **Total non-LLM** | **~$55/mo now → ~$550/mo at 10K users** |

---

## 2. Subscription Tiers

### Individual Plans (Desktop Self-Hosted)

| Tier | Price | Credits/mo | Cost @65% util | Gross Margin | Cost @100% util |
|---|---|---|---|---|---|
| **Free** | $0 | 100 | $1.43 | –$1.43 | $2.20 |
| **Solo** | $19/mo | 750 | $10.73 | $8.28 (44%) | $16.50 (↑ $2.50) |
| **Pro** | $49/mo | 2,000 | $28.60 | $20.40 (42%) | $44.00 (↑ $5.00) |
| **Power** | $149/mo | 5,500 | $78.65 | $70.35 (47%) | $121.00 (↑ $28.00) |

### Team Plan (Cloud-Hosted Agent)

| Tier | Price | Credits/mo | Seats | Cost @65% | Gross Margin |
|---|---|---|---|---|---|
| **Team** | $449/mo | 14,000 shared | Up to 10 | $245 + $50 infra | $154 (34%) |
| Extra seats | $35/seat/mo | +1,000 cr/seat | — | — | ~$28/seat |

### Enterprise (Cloud + On-Prem)

| Tier | Price | Credits/mo | Notes |
|---|---|---|---|
| **Enterprise Cloud** | $1,999/mo | 60,000 | Custom SLA, SSO, admin dashboard |
| **Enterprise On-Prem** | $3,000–15,000/mo | Unlimited (own API keys) | Near-pure margin; they supply keys |
| **White-Label** | Custom | Custom | $5K+ setup + monthly licensing |

> **On-prem is the highest-margin enterprise offering.** No LLM cost — Bhai runs on their infra with their API keys. Only cost is support and maintenance.

---

## 3. Overage Packs

Sold when monthly credits are exhausted. Highest-margin product in the lineup.

| Pack | Credits | $/credit | XAGI Cost | **Margin** |
|---|---|---|---|---|
| **Starter** | 150 | $0.067 | $3.30 | **68%** |
| **Standard** | 400 | $0.063 | $8.80 | **66%** |
| **Large** | 950 | $0.053 | $20.90 | **59%** |

Overage purchase = upsell signal. Three consecutive overage purchases in a month = auto-prompt to upgrade tier.

---

## 4. Marketplace Revenue

Infrastructure already exists: `convex/schema.ts` (`store_items`, `submissions`, `developers`, `store_reviews`, `store_installs`).

**Model:**
- Free tools: no revenue share; increases Bhai stickiness and first-run value
- Paid tools: **70/30 split** (developer keeps 70%, XAGI takes 30%)
- Pricing unit: credits (e.g., a skill priced at 500 credits = ~$11 value at Pro plan rates)

**Developer portal** (`portals/developer-portal/`) — already built. Needs payment wiring.

**Marketplace tiers:**
| Listing type | XAGI cut | Notes |
|---|---|---|
| Free skill/tool | 0% | Grows ecosystem |
| Paid skill/tool | 30% | Revenue share on each install |
| Featured placement | Flat fee or % | Premium visibility (future) |

---

## 5. Phased Go-To-Market

### Phase 1 — Desktop Product-Led Growth (Now → Month 6)

**Goal:** First 500 paying users.  
**Distribution:** Direct download from tryatlasagi.com, OTPless auth.  
**Revenue drivers:** Free → Solo/Pro upgrade funnel, overage packs.  
**Free tier strategy:** 100 credits/month ($2.20 max cost) is the acquisition mechanism. Free users who hit the wall upgrade or leave; both outcomes are acceptable.  
**Channels active:** Telegram, Discord, Slack, WhatsApp, email, desktop overlay — all already working.

**Target conversion funnel:**
- 100 signups → 30 active free users → 8 paying (~8% free-to-paid within 30 days)
- Average revenue per paying user at launch: ~$35/mo (blended Solo + Pro)

### Phase 2 — Team/Cloud Tier (Month 6–12)

**Goal:** First 50 Team accounts.  
**Distribution:** Bhai runs in XAGI's cloud (VPS per team, or containerized); users connect via their existing channels.  
**Revenue drivers:** Team subscriptions ($449/mo), extra seats ($35/seat).  
**Infrastructure cost added:** ~$50/team/mo for cloud agent hosting (Node.js process + Convex namespace).  
**Marketing motion:** Founder/operator communities (IndieHackers, Product Hunt, Twitter/X builders), cold outreach via Bhai's own marketing brain tools.

### Phase 3 — API + Enterprise (Month 12–24)

**Goal:** First 5 enterprise contracts + API beta.  
**API pricing:** $0.06/credit (same $/credit as Large overage pack; ~2.7x API cost).  
**Enterprise motion:** Inbound from large Team accounts + outbound sales.  
**On-prem option:** Unlocks procurement-blocked enterprise buyers (banking, healthcare, legal).  
**API target customers:** Developers building AI products who want Bhai's memory/orchestration/research engine without building from scratch.

---

## 6. P&L Model

Assumes blended account mix: 60% Solo, 30% Pro, 8% Power, 2% Team. 65% avg credit utilization. Free accounts excluded from paid MRR.

| Paid Users | MRR | LLM Cost | Infra | **Gross Profit** | **Margin** |
|---|---|---|---|---|---|
| 100 | $4,200 | $2,050 | $55 | $2,095 | 50% |
| 500 | $21,000 | $10,250 | $150 | $10,600 | 50% |
| 1,000 | $42,000 | $20,500 | $300 | $21,200 | 50% |
| 5,000 | $210,000 | $102,500 | $1,500 | $106,000 | 50% |
| 10,000 | $420,000 | $205,000 | $3,500 | $211,500 | 50% |

> Margin improves to ~60%+ at $50K+/mo OpenRouter spend (volume discounts from Anthropic/Google). Not modeled above.

> Overage revenue not included above — this adds ~10–20% on top at mature cohorts.

---

## 7. Key Constraints & Risks

| Risk | Mitigation |
|---|---|
| Heavy users blowing margin | Power cap at 5,500 credits; overage priced at 2.4x API cost |
| Free tier abuse | Rate limits, 1-device limit, community-only store access |
| LLM price volatility | Multi-provider fallback already built; model router auto-picks cheapest at quality target |
| Team tier margin at 100% utilization | $48 minimum margin at full use; overage designed to kick in before 100% |
| Enterprise sales cycle (6–12 months) | Phase 1/2 generate cash flow to fund Phase 3 sales investment |
| Marketplace cold-start | Seed with 10–15 high-quality first-party skills before opening to developers |

---

## 8. What Needs to Be Built

### Phase 1 (Now)
- [ ] Payment integration (Stripe or Razorpay for India) wired to Convex `accounts` table
- [ ] Credit top-up flow in desktop overlay + web portal
- [ ] Pricing page on tryatlasagi.com
- [ ] Free→paid upgrade prompt when credits drop below 20
- [ ] Overage pack purchase flow

### Phase 2
- [ ] Cloud agent hosting infrastructure (Docker + VPS per team or shared K8s)
- [ ] Team admin dashboard (multi-seat management, shared credit pool)
- [ ] Team onboarding flow (invite links, seat management)

### Phase 3
- [ ] API key issuance + developer dashboard
- [ ] API usage metering + billing
- [ ] Enterprise on-prem packaging (self-contained Docker Compose or Helm chart)
- [ ] SSO (SAML/OIDC) for enterprise

### Marketplace (parallel to Phase 1)
- [ ] Stripe Connect for developer payouts
- [ ] Paid skill install flow (credit deduction gated by `priceCredits` field — already in schema)
- [ ] Developer payout dashboard in `portals/developer-portal/`

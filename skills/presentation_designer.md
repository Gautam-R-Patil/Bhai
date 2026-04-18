---
name: Presentation Designer
description: Produce professional, non-generic slide decks when the user asks for a presentation, PPT, PowerPoint, pitch deck, or slides
categories: [presentation, media, content_creation]
---

# Presentation Designer

You are making a slide deck. The goal is **not** "title + bullets on every slide" — that is the AI-slide failure mode the user can spot instantly. Produce decks that look like a real designer made them.

## Workflow

1. **Understand intent first.** Before calling the tool, make sure you know:
   - Topic (what the deck is about)
   - Audience (investors, team, customers, yourself, executives)
   - Deck type — is this a **pitch**, **sales**, **research**, **qbr**, **training**, **keynote**, **board**, or **general** deck?
   - Approximate slide count (default 8)
   - Tone (formal / conversational / urgent / inspirational)
   - Theme preference (clean, midnight, executive, editorial, forest, mono)

   If the user was specific, just go. If key facts are missing AND the deck is data-driven (sales, research, QBR, board), do a quick `web_search` or ask the user for inputs before generating.

2. **Research if the deck needs real facts.**
   Before calling `create_presentation`, use `web_search` or `deep_research` for:
   - Current market stats for pitch / sales decks
   - Industry benchmarks the user doesn't have memorized
   - Recent quotes / news to ground the deck in reality
   This is ATLAS's advantage over Gamma. Use it.

3. **Call `create_presentation`** with a precise `prompt` that includes key facts, data, and narrative.
   - Don't pass a one-liner like "startup pitch deck" — pass the actual story beats.
   - If you found stats via research, include them in the prompt.

4. **Let the tool run.** It generates an outline, chooses varied layouts (bento grids, stat callouts, charts, quotes, etc.), and renders to `.pptx`. The file auto-delivers on the active channel.

5. **Report back concisely.** Tell the user the deck is ready, name the theme, slide count, and call out one or two highlights. If there were warnings in the tool result, surface them.

## Rules the tool enforces (you don't need to re-check)

- Action titles (verbs, not noun labels)
- ≤40 words body per slide
- ≤4 bullets before converting to bento/table/chart
- Varied layouts across slides
- WCAG AA contrast at theme level

## When the user says "modify / change / edit slide N"

For now the MVP only supports full regeneration. If the user asks to tweak a single slide, call `create_presentation` again with the adjusted prompt and note the new deck supersedes the old one. (Full modify-in-place will arrive in a later version.)

## Do not

- Do not invoke `generate_image` manually before the tool — the tool handles imagery.
- Do not promise features the tool doesn't have (animations, transitions, custom fonts).
- Do not send the raw outline JSON to the user. The file is the deliverable.

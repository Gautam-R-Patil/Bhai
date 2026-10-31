# Built-in Site Skills

Each skill is a folder with `skill.json` (`name`, `version`, `domains`,
`commits`, `questions`) and `skill.cjs` (`exports.step(phase, ctx)`), run by
`src/skills/site/runtime.ts`. User/store skills go in `~/.bhai/store/site-skills/`.
The reference skill lives with its tests in `src/skills/site/__tests__/fixtures/`.

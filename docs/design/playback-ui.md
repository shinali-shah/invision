# Playback UI

The look is the team's Figma Make design, version 2 ("Playback", night / paper / marigold). It is the source
of truth; `public/tokens.css` holds its values and `public/home.*` is a direct port of it. Every other screen
copies its components rather than inventing new ones.

## Tokens (from the Figma)

| | |
|---|---|
| night `#0d110f` · night-2 `#171d1a` · night-line `rgba(233,234,230,.16)` | the header, the hero band and the recording ticket |
| bone `#e9eae6` · bone-2 `#a9b0aa` | text on night |
| paper `#f3f3f0` · white `#fbfbf9` | page and cards |
| ink `#0d110f` · ink-2 `#4a514c` · ink-3 `#7a817c` · line `#d6d8d2` · tint `#ebece8` | text, rules, fills |
| you `#1f7a55` (`#41a87a` on night) · marigold `#f4a51c` · red-ink `#b4321e` · rec `#e2412b` | states and actions |

Type: **Big Shoulders Display** 900, uppercase, line-height .9 for every headline (the hero at
`clamp(64px, 12vw, 160px)`); **Schibsted Grotesk** for everything else, including times and counts
(tabular figures). Labels are 11.5px, 600, `.14em`, uppercase.

Shape: cards are white with a 1.5px ink border and a 22px radius; stacked sections are separated by 1.5px
ink rules. Buttons are 42px pills, marigold with ink text, 12px 700 `.12em` uppercase; ghost = ink outline;
stop/destructive = red-ink. Focus rings and text selection are marigold.

## Components to reuse

`.header` (night, 72px), `.hero-intro` (night band), `.card` / `.planner`, `.label`, `.button` / `.ghost` /
`.stop-button`, `.status-pill`, `.streak`, `.month-grid` (green / yellow / red days), `.check-row` +
`.checkbox` (circles) + `.progress`, `.followup-btn`, the recording ticket (`.recording-card` on night with
punch holes, `.live-label`, `.rec-tag`, `.live-transcript`, `.elapsed`), `.consent-step`, `.person-avatar`,
`.line`, the Replay set (`.takeaways` / `.takeaway`, `.score-strip`, `.cue-note`, `.timeline`, `mark[data-reason]`,
`.tag`, `.privacy-box`), `.modal`.

## Where things live

- **Home** (`/mac`, first tab): the Figma dashboard, with real data. Greeting hero on the night band, planner
  (calendar + streak, goals, pending tasks), the recording ticket mirroring the phone, recent conversations,
  the transcript page (takeaways, score strip, timeline, heat words, privacy box), the follow-up modal.
- **Projector view** (`/stage.html`, its own page, not a tab): same components at projector scale.
- **Replay**: the Figma transcript page plus the video, face-cue lanes and the voice picker.
- **Phone**: the recorder; the same cards, pills and the night ticket while recording, at touch sizes.

State colours: you = `--you`, them = ink-3 (bone-2 on night), awkward = red-ink, missed = marigold,
went well = `--you`.

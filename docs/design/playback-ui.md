# Playback UI

The look is the team's Figma Make design ("Playback"). It is the source of truth; `public/tokens.css` holds its
values and `public/home.*` is a direct port of it. New screens copy its components rather than inventing new ones.

## Tokens (from the Figma)

| | |
|---|---|
| ink `#292d2c` · paper `#f7f7f5` · accent (teal) `#397d74` · rec `#c8372d` | status-red `#a4504a` · status-amber `#b5832a` · sage `#8fae98` |
| ink-2 / ink-3 / line / tint | ink at 72% / 50% / 12% / 6% |
| card | white, 1px `#dedfda`, 10px radius, no shadow |
| wash | `linear-gradient(105deg, #dbe7df, #e9ebe1 45%, #f6e5da)` behind the Home hero |

Type: **Fraunces** for the page hero, **Newsreader** for headings and spoken words, **Inter** for interface text,
**JetBrains Mono** for times, dates and counts. Labels are 9–11px, 700, `.14em`, uppercase.

## Components to reuse

`.card`, `.label`, `.button` / `.ghost` / `.stop-button`, `.status-pill`, `.person-avatar`, `.check-row` +
`.checkbox` + `.progress`, `.line` (time | who | text), `.live-transcript` with the caret, `.recording-card`
(`.live-label`, `.pulse`, `.rec-tag`, `.elapsed`), `.consent-step`, `.modal`, the month grid and its key.

## Where things live

- **Home** (`/mac`, first tab): the Figma dashboard. Greeting hero with the wash and clouds, planner rail
  (calendar + streak, goals, pending tasks), recording card mirroring the phone, recent conversations with
  "What worked well" / "What I'll do next time", transcript page, follow-up modal. All data is real.
- **Live**: the projector view, same components at projector scale.
- **Replay**: the video analysis; takeaway cards, timeline and heatmap in the Figma palette.
- **Phone**: the recorder; Figma cards, consent step and buttons at touch sizes.

State colours: awkward = rec / status-red, missed = status-amber, went well = accent. "You" is accent on
transcripts; "them" is `#747a77`.

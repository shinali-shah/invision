# Playback UI direction

Source: the team's Figma Make file ("Playback" dashboard: calendar streak, goals, follow-up tasks, live
recording card, recent conversations with "what worked / next time", transcript page). We keep its structure,
teal identity and calm tone, and drop the parts that read as generated.

## What the product is about

Two people talking, and who carried the conversation. So the visual identity comes from **turn-taking**:
whose voice, when, and where it went wrong or right. Spoken words are treated differently from interface text.

## Tokens (public/tokens.css)

| Name | Light | Dark | Use |
|---|---|---|---|
| paper | `#F2F4F1` | `#121816` | page background (cool, slightly green grey, not cream) |
| surface | `#FFFFFF` | `#1A2220` | panels |
| ink | `#1E2826` | `#E4EBE7` | text |
| fog | `#5C6965` | `#9AA7A2` | secondary text (≥4.5:1 on paper) |
| hairline | `#D9DFDB` | `#2C3633` | rules and borders |
| you (teal, the brand) | `#2F6F66` | `#6FB5A9` | the user's voice, primary actions |
| them (plum slate) | `#6B5B73` | `#B6A3BE` | the other person's voice |
| awkward (brick) | `#A6443A` | `#E07A6C` | cut-ins, gossip, underselling |
| missed (amber) | `#946510` | `#D9A441` | missed moments |

Type: **Schibsted Grotesk** for interface (400/500/700, tabular figures for times and counts) and **Newsreader**
only for words someone actually said: transcripts, quotes, the "try instead" line. Scale 12 / 14 / 16 / 20 / 26 /
34 / 52. Body 16px on phones.

Shape: two radii only (6px controls, 12px panels). No drop shadows except the modal. Hairlines over boxes.

## Rules (what we deliberately don't do)

- No all-caps tracked labels. Section titles are sentence case, set in the grotesk at 14/600 in fog.
- No monospace for small data; tabular figures instead.
- No "A · B · C" meta strings in the UI; separate elements or commas.
- No arrows appended to buttons, no gradient washes, no drifting clouds, no fade-up on every card.
- One motion moment per page: the hero strand draws left to right once on load. Everything else moves only in
  answer to a tap.
- Left aligned everywhere.

## The signature: the strand

A two-lane ribbon of the conversation: you on top in teal, them underneath in plum, bar length = how long each
spoke. Marks on it: brick ticks for awkward moments, amber for missed moments, a small teal dot for follow-up
questions. It appears big in the Home hero, small beside every conversation in lists, and is the timeline on Replay.

## Home (Mac, the first section of /mac)

```
 Playback      Home   Live   Replay                            phone connected
 ────────────────────────────────────────────────────────────────────────────────
 Planner (300px, one panel, ruled)  │  Next time with Shinali, try
   October calendar + streak        │  “Sorry, you're a… what do you do?”      ← Newsreader 52
   (days coloured by how they went) │  ▔▔▔▔ ▁▁▁▁▁▁▁ ▔▔▔ ▁ ▔▔▔▔▔ ▁▁▁▁          ← strand, draws in
   Goals (from the weekly step)     │  Gossip about someone else, cut in    Open replay
   Follow-ups to send               │──────────────────────────────────────────────
     Maya: draft ready  [Write]     │  Recording on your phone  0:42    (live lines)
                                    │──────────────────────────────────────────────
                                    │  Conversations (ruled list, strand per row)
                                    │   Shinali   yesterday   ▔▁▔▁▔   What worked / Next time
```

Everything on Home is real data from the API; nothing is placeholder.

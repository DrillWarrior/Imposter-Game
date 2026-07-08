# Imposter — Case File Edition (real multiplayer)

A browser Imposter/Spyfall-style party game with a real Node.js + Socket.IO server,
so everyone plays from their own phone against one shared game state.

## Run it

```bash
npm install
npm start
```

Then open **http://localhost:3000** in a browser. Anyone on the same WiFi network
can join by visiting `http://<your-computer's-local-IP>:3000` (find your local IP
with `ipconfig getifaddr en0` on Mac or `ipconfig` on Windows).

To let friends join from anywhere (not just your WiFi), deploy this folder to a
host like Render, Railway, or Fly.io — say the word and I'll add the deploy config
for whichever one you want.

## How the flow maps to the code

1. **Real multiplayer server** — `server.js` runs an authoritative game state per
   room in memory (`rooms` Map). Clients never see the secret/decoy words except
   through a private `your-role` event sent only to that player's socket — so
   nobody can peek at another player's role by reading network traffic sent to them.
2. **Host picks categories & imposter count** — done in the lobby screen
   (`update-settings` event) via multi-select checkboxes, plus separate
   seconds-per-turn and seconds-to-guess timer settings.
3. **Tap-to-reveal redacted card** — `briefing` phase. Crew sees the real word,
   imposter(s) see the decoy, delivered privately per-player.
4. **Turn-based clue logging, 3 rounds, adjustable timer** — `clues` phase. The
   server enforces turn order (`turnOrder`, `currentTurnIndex`), runs an
   authoritative countdown per turn (`scheduleTurnTimer`), and auto-advances with
   `(no answer)` if someone runs out of time. Every submitted clue is logged into
   a table (`clueLog`) with players as columns and rounds 1-3 as rows.
5. **Voting** — `voting` phase. Self-votes are blocked server-side. Once everyone
   connected has voted (or the host forces it), the result is tallied.
6. **Imposter's last stand** — if the single most-voted player is an imposter,
   the game moves to `imposter-guess`: that player gets one timed guess at the
   real word. Guess correctly → imposter wins the round outright. Guess wrong (or
   the wrong person got voted out) → crew wins.
7. **Chat sidebar** — persistent across every phase (`send-chat` / `chat` array
   on the room), rendered as a sidebar on wide screens and a slide-in drawer on
   mobile (the floating "Chat" button).

## Known limitations (worth knowing before your first game night)

- **In-memory state only.** If the server restarts, all rooms are wiped. No
  database — appropriate for a game that lasts one sitting.
- **Imposter count is capped at 2** and the guess-mechanic currently only gives
  the *specific accused player* a guess — if you run 2 imposters and only one
  gets caught, the other one isn't addressed by the win condition yet. Tell me if
  you want multi-imposter endgames handled differently.

## Word bank (tag-based)

`WORD_BANK` in `server.js` is now a flat list of `{ word, tags }` entries
instead of category-keyed pairs. A word can carry multiple tags, so e.g.
`{ word: 'Pumpkin Pie', tags: ['Food', 'Seasonal', 'Dessert'] }` shows up
whenever the host picks Food, Seasonal, or Dessert. The list of selectable
categories in the lobby is generated automatically from every tag used across
the word bank — add a brand-new tag to any word and it becomes a pickable
category with no other code changes.

When a round starts, the server filters the word bank down to every word
carrying the chosen tag, picks one at random as the secret word, then picks a
different word from that same filtered pool as the decoy. Each tag currently
has at least 5 words in it so there's always a decoy to pick from — if you add
a brand-new tag, give it at least 2 words or that category will have nothing
to pair against.

## Imposter's hint is now a category, not a decoy word

The imposter no longer sees a specific related word. Instead they see
whichever category the secret word was drawn from (e.g. if the secret word is
"Pumpkin Pie" under the Seasonal category, the imposter just sees "Seasonal").
This is picked from whichever of the secret word's own tags actually matches
what the host selected — so it stays meaningful even with multiple categories
selected at once.

## Discussion phase before voting

After the third and final clue round, the game no longer jumps straight to
voting. It stops on a `discussion` phase — everyone can see the full clue log
and talk it out / justify their answers — and voting only opens once the host
clicks "Open Voting." No timer runs during this phase.

## Custom words

The lobby now has a "Custom Words" card. The host can type in any word or
phrase plus an optional category — leave the category blank and it defaults
to "Custom." Added words show up immediately as options in the category
checkbox grid (a new tag like "Custom" appears there automatically) and get
mixed into the word pool for that room alongside the built-in word bank.
Custom words persist for the whole session (across "Next Case" rounds) until
the host removes them with the &times; button, and only exist in that room's
memory — they're not saved anywhere and disappear when the server restarts.

There's also a **"Bulk add multiple words"** toggle in that card for adding
many at once: paste one entry per line into the textarea, either just a word
(`Roller Coaster`) or `Word: Category` (`Roller Coaster: Amusement Park`).
Lines without a colon default to the "Custom" category, same as the
single-word form. Click "Add All Lines" and every line gets parsed and added
in one shot.

## Multi-category selection

The lobby now shows a checkbox grid of every category instead of a single
dropdown — the host can check as many as they like (e.g. Food + Seasonal +
Sports at once), and each round's word is drawn from the union of every word
carrying any of the checked tags. Leaving everything unchecked pulls from the
entire word bank, across every category.

## Persistent word card

Your word/decoy no longer disappears after the initial briefing reveal. Once
you tap to break the seal, a compact card showing your stamp (Cleared/
Compromised) and word stays visible above every subsequent phase — clue
rounds, voting, and the imposter's last-chance guess — so nobody has to
remember it or scroll back. If you haven't revealed yet when a new phase
starts, the same card appears in a neutral, non-revealing style so it never
hints at your role before you tap it.

## Timers

There are now two independent timers, both host-adjustable in the lobby:
- **Seconds per turn** — how long each player gets during the 3 rounds of clue
  logging.
- **Seconds for the imposter's guess** — a separate, typically shorter, window
  for the caught imposter's last-chance word guess.

## Kicking a player

The host can remove anyone from the player list (a small &times; button next
to their name in the lobby). It works in any phase, not just the lobby — if
it happens mid-round the server cleans the kicked player out of turn order,
the clue log, and any votes so the round keeps going instead of getting stuck
waiting on someone who's gone. If they were the caught imposter awaiting their
final guess, the round resolves immediately as a wrong guess.

## Reconnecting after a reload or dropped connection

Each player's browser stores a small reconnect token (`localStorage`) once
they create or join a case. If their page reloads or their connection drops
and comes back, the client automatically re-announces itself to the server
with that token and rejoins as the *same* player — same name, same score,
same role in the current round — instead of joining fresh as a stranger.
Leaving the case (or getting kicked) clears the stored token so it doesn't
try to auto-rejoin later. This is all in-memory on the server, so it only
survives the token as long as the server process (and that room) is alive —
a server restart still wipes everything, same as before.

## Host migration

If the host's connection drops, the room isn't stuck waiting on them forever.
After a 15-second grace period (enough for a quick page refresh), if the host
still isn't back, host duties automatically pass to another currently
connected player, and a system message announces the change in chat. If the
original host reconnects within that window, they keep their host status as
normal.

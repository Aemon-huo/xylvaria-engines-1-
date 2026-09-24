# Xylvaria Engines — SillyTavern port

This is your two Janitor AI "Advanced Scripts" — the **Xylvaria Living World
Engine** and the **Fatal Consequences + Power Scaling & Luck engine** —
ported to run as a SillyTavern extension. Neither engine's internal logic
was changed; only the few lines that talked to Janitor AI's `context`
object were replaced with SillyTavern equivalents. See the comment block
at the top of `index.js` for exactly what changed and why.

## Install

1. Close SillyTavern if it's running.
2. Copy this whole `xylvaria-engines` folder into:
   `SillyTavern/public/scripts/extensions/third-party/`
   (so you end up with `.../third-party/xylvaria-engines/manifest.json`)
3. Start SillyTavern, open **Extensions**, and confirm "Xylvaria Engines
   (ported from Janitor AI)" is listed and enabled.
4. Open any chat and send a message. Both engines run automatically on
   every generation — there's nothing to paste into the character card.

## How it works

SillyTavern calls this extension's function right before building the
prompt for each reply (a "prompt interceptor"). Each turn it:

1. Reads the newest user message and the chat length — standing in for
   `context.chat.last_message` / `context.chat.message_count` from Janitor AI.
2. Runs the World Engine, then the Combat Engine, unchanged — both still
   write to a `context.character.scenario`-shaped object, exactly like before.
3. Inserts whatever they produced as one hidden "System" note right before
   your message, so the model sees it for that reply only. Nothing is
   written back into the character card, so it can't grow without bound
   over a long chat.

## State persistence

Both engines keep their character sheet / world clock on `globalThis`,
same as they did on Janitor AI (their own comments already call this
"best effort"). In a browser tab this survives for as long as the tab
stays open, but **not** a full page reload. If you'd rather have it
survive reloads too (using SillyTavern's per-chat `chatMetadata` store
instead), that's a small follow-up change — just ask.

## If you edit the engines later

Both engine bodies live inside `index.js`, clearly marked with
`BEGIN` / `END` comments (World Engine first, Combat Engine second — that
order matters, since the combat engine reads the world engine's elapsed
time). You can edit the logic between those markers exactly as you would
the original Janitor AI script; the adapter code above and below them
doesn't need to change.

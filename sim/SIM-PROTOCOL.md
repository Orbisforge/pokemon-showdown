Simulator protocol
==================

Pokémon Showdown's simulator protocol is implemented as a newline-and-pipe-delimited text stream. For details on how to read to or write from the text stream, see [sim/SIMULATOR.md](./SIMULATOR.md).

## Standalone engine protocol for Hytale

This section documents the host interface of `EngineBattleStream`. Write commands as lines starting with
`>`. Each stream output starts with a frame name, a newline, and its payload. For example:

```text
sideupdate
p1
|request|{"active":[...],"side":{...}}
```

### Commands Hytale sends

The Hytale server translates player actions and encounter rules into these commands. Read the engine's
`sideupdate` requests to know who needs to act, and wait for `end` before recording an outcome.

| When | Command | What to send |
| --- | --- | --- |
| Create the encounter | `>start <JSON>` | The explicit `format` and, for wild encounters, `wildSide`. |
| Register each participant | `>player p1 <JSON>` | The slot, team and optional starting Pokémon state. Repeat for every slot required by the format, including wild and NPC slots. |
| Respond to Team Preview | `>p1 team 213` | The participant receiving the request and their ordered team slots. |
| Choose a move | `>p1 move 1` | A move slot. Add a target when required, for example `>p1 move 1 +1`. |
| Switch or replace a fainted Pokémon | `>p1 switch 2` | A team slot allowed by the current request. |
| Submit choices for multiple active Pokémon | `>p1 move 1 +1, move 2 +2` | One choice per active slot that must act, in slot order. Use `pass` for slots that need no action when explicitly listing those slots. In Multi, each participant sends their own choice. |
| Cancel a pending choice | `>p1 undo` | The participant whose submitted choice is still pending. Only send it if cancellation is allowed. |
| Let the engine choose | `>p1 default` | The participant for whom Hytale wants the engine to pick a legal choice, for example after a timeout. |
| Use a bag item | `>useitem {"side":"p1","item":"potion","target":"party-123"}` | The acting participant, item ID and target Pokémon ID. Add `moveSlot` for Ether and Max Ether. Apply inventory consumption only if the response says `applied: true`. |
| Read trapping effects | `>trapstate` | No arguments. Use the reply as input to Hytale's escape rules. |
| Confirm a successful capture | `>capture p1 wild-123` | The capturing participant and the active wild Pokémon's stable ID. Send only in wild Singles, after Hytale determines the capture succeeded and only one wild Pokémon remains alive. |
| Confirm a successful wild escape | `>escape p1` | The escaping participant. Send after Hytale grants the escape in a wild encounter. |
| Confirm a trainer's surrender | `>forcelose p1` | The participant who surrendered. Send this for **Forfeit** in trainer battles. |
| Force a result from the server | `>forcewin p2` or `>forcetie` | The winning slot for a server-declared victory, or no arguments for a server-declared tie. Normal victories and ties are decided by the engine without a host command. |
| Read battle data | `>requestlog`, `>requestexport` or `>requestteam p1` | Optional requests for the input log, replay export or a participant's packed team. |

The base simulator's debug commands `>eval` (execute JavaScript) and `>editbattle` (edit battle state)
are unavailable on `EngineBattleStream`.

### Starting a battle and sending choices

- `>start {"format":{"mod":"gen9","gameType":"doubles","ruleset":[]}}` sets an explicit format.
- `>player p1 <JSON>` registers that participant. Supply a nonempty `team` array or a packed team string.
  You can include `pokemonState` in team order with unique IDs and initial HP, status and PP. Without
  it, IDs are assigned by side and original roster position, such as `p1:1`. These IDs stay stable
  when choosing a team or switching Pokémon.
- Use `>p1 move 1`, `>p1 switch 2` and the other [choices listed below](#possible-choices) in response
  to that side's choice request. For example, `>p1 move 1, move 2` assigns one action per active Pokémon
  in Doubles. Wait requests require no choice.

For example, Hytale starts a wild Singles encounter by writing these three lines:

```text
>start {"format":{"mod":"gen9","gameType":"singles","ruleset":[]},"wildSide":"p2"}
>player p1 {"name":"Trainer","team":[{"species":"Pikachu","moves":["Tackle"]}],"pokemonState":[{"id":"party-123"}]}
>player p2 {"name":"Wild Eevee","team":[{"species":"Eevee","moves":["Tackle"]}],"pokemonState":[{"id":"wild-123"}]}
```

After the engine requests choices, Hytale can submit the player's action with `>p1 move 1` and the wild
Pokémon's action with `>p2 move 1`. For a granted escape, send `>escape p1` instead of a move choice.
For a trainer match, omit `wildSide` from the initial command and use `>forcelose p1` if that trainer
confirms surrender.

| `gameType` | Participants and active slots |
| --- | --- |
| `singles` | `p1` against `p2`, one active Pokémon per participant |
| `doubles` | `p1` against `p2`, two active Pokémon per participant |
| `triples` | `p1` against `p2`, three active Pokémon per participant |
| `multi` | `p1` and `p3` against `p2` and `p4`, one active Pokémon per participant |
| `freeforall` | `p1` through `p4` play independently, one active Pokémon per participant |

For a wild encounter, include `"wildSide":"p2"` at the top level of `>start`. This marks the whole team
containing `p2` as wild. In Multi that includes `p4`. Omit `wildSide` for trainer battles. Free-for-All
does not support a wild team.

### Output frames

| Frame | Payload | How the host uses it |
| --- | --- | --- |
| `update` | One or more standard Showdown lines separated by newlines | Read [battle events](#receiving-messages) such as turn, move, switch, HP change, status, faint, victory and tie, plus the engine-specific lines below. The raw payload can contain `\|split\|` lines with private data. Filter those by recipient before forwarding a client view. |
| `sideupdate` | Side ID on its own line, then the event line | Deliver only to that participant. `\|request\|` carries a [choice request](#choice-requests) or an update to it. `\|error\|` reports an invalid or unavailable choice. Side updates can also contain private battle notices. |
| `bagitem` | JSON object | Response to a valid `>useitem` command. Fields are `side`, `item` (normalized ID), `target`, `applied` and `pokemonState`. |
| `trapstate` | JSON array | Server-only response to `>trapstate`. Contains trapping details for living active Pokémon. |
| `escape` | JSON object | Rejection of an escape command. Contains the requested `side`, `applied: false` and a `reason`. |
| `end` | JSON object | Final result and Pokémon state for the host. Use this frame to settle the match and persist results. |
| `requesteddata` | Plain text | Response to `>requestlog` (input lines), `>requestexport` (seed, then input lines), or `>requestteam p1` (packed team). |

These are the normal host stream frames. The stream's replay mode outputs filtered battle log lines
instead of the framed battle events. Command errors that throw are surfaced as stream errors by default
or thrown to the caller with `noCatch`. A rejected choice or rejected escape uses the frames above.

### Engine events and the commands that produce them

| Command or trigger | Event | Meaning |
| --- | --- | --- |
| `>useitem {"side":"p1","item":"potion","target":"party-123"}` | `bagitem` response. On success the log records `\|bagitem\|SIDE\|POKEMON\|ITEM_ID` and can include effect lines such as healing or status changes. | Runs a built-in bag effect on that participant's battle team while they have a move request. Use the response's `applied` field to confirm consumption. A valid item with no effect returns `applied: false`. Ether and Max Ether require a one-based `moveSlot`. Revive and Max Revive target fainted members on the bench. The host owns the inventory and decides whether use consumes a choice. |
| `>trapstate` | `trapstate` response | Reads the latest trapping effects evaluated by the simulator. This does not make a turn choice or attempt to escape. |
| `>capture p1 wild-123` | `\|capture\|POKEMON\|POKEMON_ID` followed by `end` | The host confirms a successful capture in wild Singles. The target must be the active wild Pokémon and the only living member of the wild team. The engine removes it from play, records the capture in `inputLog` and returns its state in `capturedPokemon`. |
| `>escape p1` | `\|escape\|p1` followed by `end`, or a rejection frame | Confirms an escape already resolved by the host. Only a participant facing a wild team may escape. A rejection leaves the battle open. |
| `>forcelose p1` | `\|forfeit\|p1` | Confirms a trainer's surrender. Ends Singles, Doubles and Triples. In Multi, the participant's team loses. In Free-for-All, the others continue until a winner is determined. |
| Normal knockout victory or `>forcewin p2` | `\|win\|PLAYER_NAME` followed by `end` | One side or team wins. Multi lists both allied names on the log line. Use the side IDs in `end` for results. |
| Normal tie or `>forcetie` | `\|tie` followed by `end` | Ends without a winner. |

In Hytale, expose **Run** in wild encounters and **Forfeit** in trainer battles. Hytale can use the
trapping response to decide whether to offer or grant escape. An escape confirmation rejected by the
engine returns one of these reasons:

| Rejection reason | Meaning |
| --- | --- |
| `not-wild-encounter` | The battle has no `wildSide`. |
| `battle-not-active` | The wild encounter has not reached its first turn or has already ended. |
| `invalid-player-side` | The requested side is unknown, eliminated or on the wild team. |

#### Trapping payload

Each entry contains `id`, `side`, `switchBlocked` and `sources`. `switchBlocked` describes the
simulator's switch restriction. The host applies its own escape rules using the effects in `sources`.
Effects can have a different internal ID and cause ID. For example, Magma Storm produces the
`partiallytrapped` condition:

```json
[
  {
    "id": "party-123",
    "side": "p1",
    "switchBlocked": true,
    "sources": [
      {
        "id": "partiallytrapped",
        "name": "partiallytrapped",
        "type": "Condition",
        "causeId": "magmastorm",
        "causeName": "Magma Storm",
        "sourcePokemonId": "wild-123",
        "remainingTurns": 3,
        "hidden": false
      }
    ]
  }
]
```

An ability like Arena Trap reports the ability as the cause. `remainingTurns` is present when the
effect tracks a duration, and `sourcePokemonId` is present when a source Pokémon can be identified.
Sources with `hidden: true` can reveal hidden abilities. Keep the full response on the server.

#### Final result

| `reason` | Final outcome |
| --- | --- |
| `victory` | The engine determined a winner, or the host declared one with `>forcewin`. An ending capture can also produce a victory. |
| `forfeit` | The surrender determined the winner. In Free-for-All, earlier surrenders still appear in `forfeitedSides` if the eventual winner is decided through play. |
| `tie` | Neither side won. `winningSides` and `losingSides` are empty. |
| `escape` | A player escaped a wild encounter. `escapedSide` identifies the player and both result arrays are empty. |

If `p1` forfeits in Multi, the relevant result fields are:

```json
{
  "reason": "forfeit",
  "winningSides": ["p2", "p4"],
  "losingSides": ["p1", "p3"],
  "forfeitedSides": ["p1"],
  "capturedPokemon": []
}
```

`pokemonState` maps each participant ID to its original roster's final states. Captured Pokémon are
removed from that roster's output and appear in `capturedPokemon`. Each exported Pokémon state has
`id`, `hp`, `maxHp`, `status` and `pp` in team move order. A sleeping Pokémon also has
`sleepTurns`. The same state shape appears in the bag item response under `pokemonState`.

The frame also includes the standard Showdown fields `winner`, `seed`, `turns`, player names
(`p1` through `p4` as applicable), submitted teams (`p1team` through `p4team` as applicable),
`score` (remaining Pokémon by side slot) and `inputLog`. Use `winningSides` for settlement because
the standard `winner` field is a display name. Replay `inputLog` through `EngineBattleStream` to
reproduce a capture with the same format and wild side.


Receiving messages
------------------

### Battle initialization

The beginning of a battle will look something like this:

    |player|p1|Anonycat|60|1200
    |player|p2|Anonybird|113|1300
    |teamsize|p1|4
    |teamsize|p2|5
    |gametype|doubles
    |gen|7
    |tier|[Gen 7] Doubles Ubers
    |rule|Species Clause: Limit one of each Pokémon
    |rule|OHKO Clause: OHKO moves are banned
    |rule|Moody Clause: Moody is banned
    |rule|Evasion Abilities Clause: Evasion abilities are banned
    |rule|Evasion Moves Clause: Evasion moves are banned
    |rule|Endless Battle Clause: Forcing endless battles is banned
    |rule|HP Percentage Mod: HP is shown in percentages
    |clearpoke
    |poke|p1|Pikachu, L59, F|item
    |poke|p1|Kecleon, M|item
    |poke|p1|Jynx, F|item
    |poke|p1|Mewtwo|item
    |poke|p2|Hoopa-Unbound|
    |poke|p2|Smeargle, L1, F|item
    |poke|p2|Forretress, L31, F|
    |poke|p2|Groudon, L60|item
    |poke|p2|Feebas, L1, M|
    |teampreview
    |
    |start

`|player|PLAYER|USERNAME|AVATAR|RATING`

> Player details.
>
> - `PLAYER` is `p1` or `p2`
> - `PLAYER` may also be `p3` or `p4` in 4 player battles
> - `USERNAME` is the username
> - `AVATAR` is the player's avatar
> - `RATING` is the player's Elo rating in the format they're playing. This will only be displayed in rated battles and when the player is first introduced otherwise it's blank

`|teamsize|PLAYER|NUMBER`

> - `PLAYER` is `p1`, `p2`, `p3`, or `p4`
> - `NUMBER` is the number of Pokémon your opponent starts with. In games
>   without Team Preview, you don't know which Pokémon your opponent has, but
>   you at least know how many there are.

`|gametype|GAMETYPE`

> - `GAMETYPE` is `singles`, `doubles`, `triples`, `multi`, or `freeforall`.

`|gen|GENNUM`

> Generation number, from 1 to 9. Stadium counts as its respective gens;
> Let's Go counts as 7, and modded formats count as whatever gen they were
> based on.

`|tier|FORMATNAME`

> The name of the format being played.

`|rated`

> Will be sent if the game will affect the player's ladder rating (Elo
> score).

`|rated|MESSAGE`

> Will be sent if the game is official in some other way, such as being
> a tournament game. Does not actually mean the game is rated.

`|rule|RULE: DESCRIPTION`

> Will appear multiple times, one for each rule.

`|clearpoke`  
`|poke|PLAYER|DETAILS|ITEM`  
`|poke|PLAYER|DETAILS|ITEM`  
...  
`|teampreview`

> These messages appear if you're playing a format that uses team previews.

`|clearpoke`

> Marks the start of Team Preview

`|poke|PLAYER|DETAILS|ITEM`

> Declares a Pokémon for Team Preview.
>
> - `PLAYER` is the player ID (see `|player|`)
> - `DETAILS` describes the pokemon (see "Identifying Pokémon" below)
> - `ITEM` will be `item` if the Pokémon is holding an item, or blank if it isn't.
>
> Note that forme and shininess are hidden on this, unlike on the `|switch|`
> details message.

`|start`

> Indicates that the game has started.

### Battle progress

`|`

> Clears the message-bar, and add a spacer to the battle history. This is
> usually done automatically by detecting the message-type, but can also
> be forced to happen with this.

`|request|REQUEST`

> Gives a JSON object containing a request for a choice (to move or
> switch). To assist in your decision, `REQUEST.active` has information
> about your active Pokémon, and `REQUEST.side` has information about your
> your team as a whole. `REQUEST.rqid` is an optional request ID (see
> "Sending decisions" for details).

`|inactive|MESSAGE` or `|inactiveoff|MESSAGE`

> A message related to the battle timer has been sent. The official client
> displays these messages in red.
>
> `inactive` means that the timer is on at the time the message was sent,
> while `inactiveoff` means that the timer is off.

`|upkeep`

> Signals the upkeep phase of the turn where the number of turns left for field
> conditions are updated.

`|turn|NUMBER`

> It is now turn `NUMBER`.

`|win|USER`

> `USER` has won the battle.

`|tie`

> The battle has ended in a tie.

`|t:|TIMESTAMP`

> The current UNIX timestamp (the number of seconds since 1970) - useful for determining
> when events occurred in real time.

### Identifying Pokémon

Pokémon will be identified by a Pokémon ID (generally labeled `POKEMON` in
this document), and, in certain cases, also a details string (generally
labeled `DETAILS`).

A Pokémon ID is in the form `POSITION: NAME`.

- `POSITION` is the spot that the Pokémon is in: it consists of the `PLAYER`
  of the player (see `|player|`), followed by a position letter (`a` in
  singles).

An inactive Pokémon will not have a position letter.

In doubles and triples battles, `a` will refer to the leftmost Pokémon
from its trainer's perspective (so the leftmost on your team, and the
rightmost on your opponent's team, so `p1a` faces `p2c`, etc).

So the layout looks like:

Doubles, player 1's perspective:

    p2b p2a
    p1a p1b

Doubles, player 2's perspective:

    p1b p1a
    p2a p2b

In multi and free-for-all battles, players are grouped by parity. That is,
`p1` and `p3` share a side, as do `p2` and `p4`. The position letters still
follow the same conventions as in double battles, so the layout looks like:

Multi, player 1's perspective

    p4b p2a
    p1a p3b

- `NAME` is the nickname of the Pokémon (or the species name, if no nickname
  is given).

For example: `p1a: Sparky` could be a Charizard named Sparky.
`p1: Dragonite` could be an inactive Dragonite being healed by Heal Bell.

- `DETAILS` is a comma-separated list of all information about a Pokemon
  visible on the battle screen: species, shininess, gender, and level. So it
  starts with `SPECIES`, adding `, L##` if it's not level 100, `M` if it's male,
  `, F` if it's female, `, shiny` if it's shiny.
  In Gen 9, `, tera:TYPE` will be appended if the Pokemon has Terastallized.

So, for instance, `Deoxys-Speed` is a level 100 non-shiny genderless
Deoxys (Speed forme). `Sawsbuck, L50, F, shiny` is a level 50 shiny female
Sawsbuck (Spring form).

In Team Preview, `DETAILS` will not include information not available in
Team Preview (in particular, level and shininess will be left off), and
for Pokémon whose forme isn't revealed in Team Preview, it will be given as
`-*`. So, for instance, an Arceus in Team Preview would have the details
string `Arceus-*`, no matter what kind of Arceus it is.

For most commands, you can just use the position information in the
Pokémon ID to identify the Pokémon. Only a few commands actually change the
Pokémon in that position (`|switch|` switching, `|replace|` illusion dropping,
`|drag|` phazing, and `|detailschange|` permanent forme changes), and these
all specify `DETAILS` for you to perform updates with.

### Major actions

In battle, most Pokémon actions come in the form `|ACTION|POKEMON|DETAILS`
followed by a few messages detailing what happens after the action occurs.

Battle actions (especially minor actions) often come with tags such as
`|[from] EFFECT|[of] SOURCE`. `EFFECT` will be an effect (move, ability,
item, status, etc), and `SOURCE` will be a Pokémon. These can affect the
message or animation displayed, but do not affect anything else. Other 
tags include `|[still]` (suppress animation) and `|[silent]` (suppress
message).

`|move|POKEMON|MOVE|TARGET`

> The specified Pokémon has used move `MOVE` at `TARGET`. If a move has
> multiple targets or no target, `TARGET` should be ignored. If a move
> targets a side, `TARGET` will be a (possibly fainted) Pokémon on that
> side.
>
> If `|[miss]` is present, the move missed.
>
> If `|[still]` is present, the move should not animate 
>
> `|[anim] MOVE2` tells the client to use the animation of `MOVE2` instead
> of `MOVE` when displaying to the client.

`|switch|POKEMON|DETAILS|HP STATUS` or `|drag|POKEMON|DETAILS|HP STATUS`

> A Pokémon identified by `POKEMON` has switched in (if there was an old
> Pokémon in that position, it is switched out).
>
> For the DETAILS format, see "Identifying Pokémon" above.
>
> `POKEMON|DETAILS` represents all the information that can be used to tell
> Pokémon apart. If two pokemon have the same `POKEMON|DETAILS` (which will
> never happen in any format with Species Clause), you usually won't be able
> to tell if the same pokemon switched in or a different pokemon switched
> in.
>
> The switched Pokémon has HP `HP`, and status `STATUS`. `HP` is specified as
> a fraction; if it is your own Pokémon then it will be `CURRENT/MAX`, if not,
> it will be `/100` if HP Percentage Mod is in effect and `/48` otherwise.
> `STATUS` can be left blank, or it can be `slp`, `par`, etc.
>
> `switch` means it was intentional, while `drag` means it was unintentional
> (forced by Whirlwind, Roar, etc).

`|detailschange|POKEMON|DETAILS|HP STATUS` or 
`|-formechange|POKEMON|SPECIES|HP STATUS`

> The specified Pokémon has changed formes (via Mega Evolution, ability, etc.) 
> to `SPECIES`. If the forme change is permanent (Mega Evolution or a 
> Shaymin-Sky that is frozen), then `detailschange` will appear; otherwise, 
> the client will send `-formechange`.
>
> Syntax is the same as `|switch|` above.

`|replace|POKEMON|DETAILS|HP STATUS`

> Illusion has ended for the specified Pokémon. Syntax is the same as
> `|switch|` above, but remember that everything you thought you knew about the
> previous Pokémon is now wrong.
>
> `POKEMON` will be the NEW Pokémon ID - i.e. it will have the nickname of the
> Zoroark (or other Illusion user).

`|swap|POKEMON|POSITION`

> Moves already active `POKEMON` to active field `POSITION` where the
> leftmost position is 0 and each position to the right counts up by 1.

`|cant|POKEMON|REASON` or `|cant|POKEMON|REASON|MOVE`

> The Pokémon `POKEMON` could not perform a move because of the indicated
> `REASON` (such as paralysis, Disable, etc). Sometimes, the move it was
> trying to use is given.

`|faint|POKEMON`

> The Pokémon `POKEMON` has fainted.

### Minor actions

Minor actions are less important than major actions. In the official client,
they're usually displayed in small font if they have a message. Pretty much
anything that happens in a battle other than a switch or the fact that a move
was used is a minor action. So yes, the effects of a move such as damage or
stat boosts are minor actions.

`|-fail|POKEMON|ACTION`

> The specified `ACTION` has failed against the `POKEMON` targeted. The
> `ACTION` in question should be a move that fails due to its own mechanics.
> Moves (or effect activations) that fail because they're blocked by another
> effect should use `-block` instead.

`|-block|POKEMON|EFFECT|MOVE|ATTACKER`

> An effect targeted at `POKEMON` was blocked by `EFFECT`. This may optionally
> specify that the effect was a `MOVE` from `ATTACKER`. `[of]SOURCE` will note
> the owner of the `EFFECT`, in the case that it's not `EFFECT` (for instance,
> an ally with Aroma Veil.)

`|-notarget|POKEMON`

> A move has failed due to their being no target Pokémon `POKEMON`. `POKEMON` is
> not present in Generation 1. This action is specific to Generations 1-4 as in
> later Generations a failed move will display using `-fail`.

`|-miss|SOURCE|TARGET`

> The move used by the `SOURCE` Pokémon missed (maybe absent) the `TARGET`
> Pokémon.

`|-damage|POKEMON|HP STATUS`

> The specified Pokémon `POKEMON` has taken damage, and is now at
> `HP STATUS` (see `|switch|` for details).
>
> If `HP` is 0, `STATUS` should be ignored. The current behavior is for
> `STATUS` to be `fnt`, but this may change and should not be relied upon.

`|-heal|POKEMON|HP STATUS`

> Same as `-damage`, but the Pokémon has healed damage instead.

`|-sethp|POKEMON|HP`

> The specified Pokémon `POKEMON` now has `HP` hit points.

`|-status|POKEMON|STATUS`

> The Pokémon `POKEMON` has been inflicted with `STATUS`.

`|-curestatus|POKEMON|STATUS`

> The Pokémon `POKEMON` has recovered from `STATUS`.

`|-cureteam|POKEMON`

> The Pokémon `POKEMON` has used a move that cures its team of status effects, 
> like Heal Bell.

`|-boost|POKEMON|STAT|AMOUNT`

> The specified Pokémon `POKEMON` has gained `AMOUNT` in `STAT`, using the
> standard rules for Pokémon stat changes in-battle. `STAT` is a standard
> three-letter abbreviation fot the stat in question, so Speed will be `spe`,
> Special Defense will be `spd`, etc.

`|-unboost|POKEMON|STAT|AMOUNT`

> Same as `-boost`, but for negative stat changes instead.

`|-setboost|POKEMON|STAT|AMOUNT`

> Same as `-boost` and `-unboost`, but `STAT` is *set* to `AMOUNT` instead of
> boosted *by* `AMOUNT`. (For example: Anger Point, Belly Drum)

`|-swapboost|SOURCE|TARGET|STATS`

> Swaps the boosts from `STATS` between the `SOURCE` Pokémon and `TARGET`
> Pokémon. `STATS` takes the form of a comma-separated list of `STAT`
> abbreviations as described in `-boost`. (For example: Guard Swap, Heart
> Swap).

`|-invertboost|POKEMON`

> Invert the boosts of the target Pokémon `POKEMON`. (For example: Topsy-Turvy).

`|-clearboost|POKEMON`

> Clears all of the boosts of the target `POKEMON`. (For example: Clear Smog).

`|-clearallboost`

> Clears all boosts from all Pokémon on both sides. (For example: Haze).

`|-clearpositiveboost|TARGET|POKEMON|EFFECT`

> Clear the positive boosts from the `TARGET` Pokémon due to an `EFFECT` of the
> `POKEMON` Pokémon. (For example: 'move: Spectral Thief').

`|-clearnegativeboost|POKEMON`

> Clear the negative boosts from the target Pokémon `POKEMON`. (For example:
> usually as the result of a `[zeffect]`).

`|-copyboost|SOURCE|TARGET`

> Copy the boosts from `SOURCE` Pokémon to `TARGET` Pokémon (For example: Psych
> Up).

`|-weather|WEATHER`

> Indicates the weather that is currently in effect. If `|[upkeep]` is present,
> it means that `WEATHER` was active previously and is still in effect that
> turn. Otherwise, it means that the weather has changed due to a move or ability,
> or has expired, in which case `WEATHER` will be `none`.

`|-fieldstart|CONDITION`

> The field condition `CONDITION` has started. Field conditions are all effects that
> affect the entire field and aren't a weather. (For example: Trick Room, Grassy
> Terrain)

`|-fieldend|CONDITION`

> Indicates that the field condition `CONDITION` has ended.

`|-fieldactivate|CONDITION`

> A single-event field effect `CONDITION` has triggered.
> (i.e. Teatime, Electrify, Perish Song, extreme weather activation)

`|-sidestart|SIDE|CONDITION`

> A side condition `CONDITION` has started on `SIDE`. Side conditions are all
> effects that affect one side of the field. (For example: Tailwind, Stealth
> Rock, Reflect)

`|-sideend|SIDE|CONDITION`

> Indicates that the side condition `CONDITION` ended for the given `SIDE`.

`|-swapsideconditions`

> Swaps side conditions between sides. Used for Court Change.

`|-start|POKEMON|EFFECT`

> A [*volatile* status](https://bulbapedia.bulbagarden.net/wiki/Status_condition#Volatile_status)
> has been inflicted on the `POKEMON` Pokémon by `EFFECT`. (For example:
> confusion, Taunt, Substitute).

`|-end|POKEMON|EFFECT`

> The volatile status from `EFFECT` inflicted on the `POKEMON` Pokémon has
> ended.

`|-crit|POKEMON`

> A move has dealt a critical hit against the `POKEMON`.

`|-supereffective|POKEMON`

> A move was super effective against the `POKEMON`.

`|-resisted|POKEMON`

> A move was not very effective against the `POKEMON`.

`|-immune|POKEMON`

> The `POKEMON` was immune to a move.

`|-item|POKEMON|ITEM|[from]EFFECT`

> The `ITEM` held by the `POKEMON` has been changed or revealed due to a move or 
> ability `EFFECT`.

`|-item|POKEMON|ITEM`

> `POKEMON` has just switched in, and its item `ITEM` is being announced to have a
> long-term effect (will not use `[from]`). Air Balloon is the only current user of
> this.

`|-enditem|POKEMON|ITEM|[from]EFFECT`

> The `ITEM` held by `POKEMON` has been destroyed by a move or ability (like
> Knock Off), and it now holds no item.
>
> This will be silent `[silent]` if the item's ownership was changed (with a move
> or ability like Thief or Trick), even if the move or ability would result in
> a Pokémon without an item.

`|-enditem|POKEMON|ITEM`

> `POKEMON`'s `ITEM` has destroyed itself (consumed Berries, Air Balloon). If a
> berry is consumed, it also has an additional modifier `|[eat]` to indicate
> that it was consumed.
>
> Sticky Barb does not announce itself with this or any other message when it
> changes hands.

`|-ability|POKEMON|ABILITY|[from]EFFECT`

> The `ABILITY` of the `POKEMON` has been changed due to a move/ability `EFFECT`.
>
> Note that Skill Swap does not send this message despite it changing abilities,
> because it does not reveal abilities when used between allies in a Double or
> Triple Battle.

`|-ability|POKEMON|ABILITY`

> `POKEMON` has just switched-in, and its ability `ABILITY` is being announced
> to have a long-term effect (will not use `[from]`).
>
> Effects that start at switch-in include Mold Breaker and Neutralizing Gas. It
> does not include abilities that activate once and don't have any long-term
> effects, like Intimidate (Intimidate should use `-activate`).

`|-endability|POKEMON`

> The `POKEMON` has had its ability suppressed by Gastro Acid.

`|-transform|POKEMON|SPECIES`

> The Pokémon `POKEMON` has transformed into `SPECIES` by the move Transform or
> the ability Imposter.

`|-mega|POKEMON|MEGASTONE`

> The Pokémon `POKEMON` used `MEGASTONE` to Mega Evolve.

`|-primal|POKEMON`

> The Pokémon `POKEMON` has reverted to its primal forme.

`|-burst|POKEMON|SPECIES|ITEM`

> The Pokémon `POKEMON` has used `ITEM` to Ultra Burst into `SPECIES`.

`|-zpower|POKEMON`

> The Pokémon `POKEMON` has used the z-move version of its move.

`|-zbroken|POKEMON`

> A z-move has broken through protect and hit the `POKEMON`.

`|-activate|EFFECT`

> A miscellaneous effect has activated. This is triggered whenever an effect could 
> not be better described by one of the other minor messages: for example, healing 
> abilities like Water Absorb simply use `-heal`.
>
> Items usually activate with `-end`, although items with two messages, like Berries
> ("POKEMON ate the Leppa Berry! POKEMON restored PP...!"), will send the "ate"
> message as `-eat`, and the "restored" message as `-activate`.

`|-hint|MESSAGE`

> Displays a message in parentheses to the client. Hint messages appear to explain and 
> clarify why certain actions, such as Fake Out and Mat Block failing, have occurred,  
> when there would normally be no in-game messages.

`|-center`

> Appears in Triple Battles when only one Pokémon remains on each side, to indicate
> that the Pokémon have been automatically centered.

`|-message|MESSAGE`

> Displays a miscellaneous message to the client. These messages are primarily used 
> for messages from game mods that aren't supported by the client, like rule clauses 
> such as Sleep Clause, or other metagames with custom messages for specific scenarios. 

`|-combine`

> A move has been combined with another (For example: Fire Pledge).

`|-waiting|SOURCE|TARGET`

> The `SOURCE` Pokémon has used a move and is waiting for the `TARGET` Pokémon
> (For example: Fire Pledge).

`|-prepare|ATTACKER|MOVE`
> The `ATTACKER` Pokémon is preparing to use a charge `MOVE` on an unknown target.
> (For example: Dig, Fly).

`|-prepare|ATTACKER|MOVE|DEFENDER`

> The `ATTACKER` Pokémon is preparing to use a charge `MOVE` on the `DEFENDER`.
> (For example: Sky Drop).

`|-mustrecharge|POKEMON`

> The Pokémon `POKEMON` must spend the turn recharging from a previous move.

`|-nothing`

> **DEPRECATED**: A move did absolutely nothing. (For example: Splash). In the
> future this will be of the form `|-activate|POKEMON|move: Splash`.

`|-hitcount|POKEMON|NUM`

> A multi-hit move hit the `POKEMON` `NUM` times.

`|-singlemove|POKEMON|MOVE`

> The Pokémon `POKEMON` used move `MOVE` which causes a temporary effect lasting
> the duration of the move. (For example: Grudge, Destiny Bond).

`|-singleturn|POKEMON|MOVE`

> The Pokémon `POKEMON` used move `MOVE` which causes a temporary effect lasting
> the duration of the turn. (For example: Protect, Focus Punch, Roost).


Sending decisions
-----------------

Using the Pokémon Showdown client, you can specify decisions with
`/choose CHOICE`, or, for move and switch decisions, just `/CHOICE` works as
well.

Using the simulator API, you would write `>p1 CHOICE` or `>p2 CHOICE` into the
battle stream.

### Possible choices

You can see the syntax in action by looking at the JavaScript console when
playing a Pokémon Showdown battle in a browser such as Chrome.

As an overview:

- `switch Pikachu`, `switch pikachu`, or `switch 2` are all valid `CHOICE`
  strings to switch to a Pikachu in slot 2.

- `move Focus Blast`, `move focusblast`, or `move 4` are all valid `CHOICE`
  strings to use Focus Blast, your active Pokemon's 4th move.

In Doubles, decisions are delimited by `,`. If you have a Manectric and a
Cresselia, `move Thunderbolt 1 mega, move Helping Hand -1` will make the
Manectric mega evolve and use Thunderbolt at the opponent in slot 1, while
Cresselia will use Helping Hand at Manectric.

To be exact, `CHOICE` is one of:

- `team TEAMSPEC`, during Team Preview, where `TEAMSPEC` is a list of pokemon
  slots.
  - For instance, `team 213456` will swap the first two Pokemon and keep all
    other pokemon in order.
  - `TEAMSPEC` does not have to be all pokemon: `team 5231` might be a choice
    in VGC.
  - If you have more than 10 Pokémon, `TEAMSPEC` must be comma-separated:
    `team 2, 1, 3, 4, 5, 6, 7, 8, 9, 10`
  - `TEAMSPEC` can be surrounded by brackets to disable auto-adding commas.
    `team [31]` will be an error while `team 31` will be parsed as
    `team 3, 1`. This is intended to be used by clients for stricter error
    messages; end users can always leave them off for convenience.

- `default`, to auto-choose a decision. This will be the first possible legal
  choice. This is what's used in VGC if you run out of Move Time.

- `undo`, to cancel a previously-made choice. This can only be done if the
  another player needs to make a choice and hasn't done so yet (or if you are
  calling `side.choose()` directly, which doesn't auto-continue when both
  players have made a choice).

- `POKEMONCHOICE` in Singles

- `POKEMONCHOICE, POKEMONCHOICE` in Doubles

`POKEMONCHOICE` is one of:

- `default`, to auto-choose a decision

- `pass`, to skip a slot in Doubles/Triples that doesn't need a decision (can
  be left off, but can be useful for readability, to mean "the pokemon in this
  slot is fainted and won't be making a move")

- `move MOVESPEC`, to make a move

- `move MOVESPEC mega`, to mega-evolve and make a move

- `move MOVESPEC zmove`, to use a z-move version of a move

- `move MOVESPEC max`, to Dynamax/Gigantamax and make a move

- `move MOVESPEC terastalize`, to Terastalize and make a move

- `switch SWITCHSPEC`, to make a switch

`MOVESPEC` is:

- `MOVESLOTSPEC` or `MOVESLOTSPEC TARGETSPEC`
  - `MOVESLOTSPEC` is a move name (capitalization/spacing-insensitive) or
    1-based move slot number
  - `TARGETSPEC` is a 1-based target slot number. Add a `-` in front of it to
    refer to allies, and a `+` to refer to foes. Remember that slots go in
    opposite directions, like this:

         Triples       Doubles
        +3 +2 +1        +2 +1
        -1 -2 -3        -1 -2

    (Slot numbers are unnecessary in Singles: you can never choose a target in
    Singles.)

`SWITCHSPEC` is:

- a Pokémon nickname/species or 1-based slot number
  - Note that if you have multiple Pokémon with the same nickname/species, using the
    nickname/species will select the first unfainted one. If you want another Pokémon,
    you'll need to specify it by slot number.

Once a choice has been set for all players who need to make a choice, the
battle will continue.

If an invalid decision is sent (trying to switch when you're trapped by
Mean Look or something), you will receive a message starting with:

`|error|[Invalid choice] MESSAGE`

This will tell you to send a different decision. If your previous choice
revealed additional information (For example: a move disabled by Imprison
or a trapping effect), the error will be followed with a `|request|` command
to base your decision off of:

`|error|[Unavailable choice] MESSAGE`  
`|request|REQUEST`

### Choice requests

The protocol message to tell you that it's time for you to make a decision
is:

`|request|REQUEST`

> Gives a JSON object containing a request for a choice (to move or
> switch). To assist in your decision, `REQUEST.active` has information
> about your active Pokémon, and `REQUEST.side` has information about your
> your team as a whole.
>
> If you're using the simulator through a Pokémon Showdown server,
> `REQUEST.rqid` is an optional request ID. It will not exist if you're
> using the simulator directly through `import sim` or
> `./pokemon-showdown simulate-battle`.
>
> When sending decisions to a Pokémon Showdown server with `/choose`, you
> can add `|RQID` at the end. `RQID` is `REQUEST.rqid`, and it identifies
> which request the decision was intended for, making sure "Undo" doesn't
> cause the next decision to be sent for the wrong turn.

Example request object:

```
{
  "active": [
    {
      "moves": [
        {
          "move": "Light Screen",
          "id": "lightscreen",
          "pp": 48,
          "maxpp": 48,
          "target": "allySide",
          "disabled": false
        },
        {
          "move": "U-turn",
          "id": "uturn",
          "pp": 32,
          "maxpp": 32,
          "target": "normal",
          "disabled": false
        },
        {
          "move": "Knock Off",
          "id": "knockoff",
          "pp": 32,
          "maxpp": 32,
          "target": "normal",
          "disabled": false
        },
        {
          "move": "Roost",
          "id": "roost",
          "pp": 16,
          "maxpp": 16,
          "target": "self",
          "disabled": false
        }
      ]
    }
  ],
  "side": {
    "name": "Zarel",
    "id": "p2",
    "pokemon": [
      {
        "ident": "p2: Ledian",
        "details": "Ledian, L83, M",
        "condition": "227/227",
        "active": true,
        "stats": {
          "atk": 106,
          "def": 131,
          "spa": 139,
          "spd": 230,
          "spe": 189
        },
        "moves": [
          "lightscreen",
          "uturn",
          "knockoff",
          "roost"
        ],
        "baseAbility": "swarm",
        "item": "leftovers",
        "pokeball": "pokeball",
        "ability": "swarm"
      },
      {
        "ident": "p2: Pyukumuku",
        "details": "Pyukumuku, L83, F",
        "condition": "227/227",
        "active": false,
        "stats": {
          "atk": 104,
          "def": 263,
          "spa": 97,
          "spd": 263,
          "spe": 56
        },
        "moves": [
          "recover",
          "counter",
          "lightscreen",
          "reflect"
        ],
        "baseAbility": "innardsout",
        "item": "lightclay",
        "pokeball": "pokeball",
        "ability": "innardsout"
      },
      {
        "ident": "p2: Heatmor",
        "details": "Heatmor, L83, F",
        "condition": "277/277",
        "active": false,
        "stats": {
          "atk": 209,
          "def": 157,
          "spa": 222,
          "spd": 157,
          "spe": 156
        },
        "moves": [
          "fireblast",
          "suckerpunch",
          "gigadrain",
          "focusblast"
        ],
        "baseAbility": "flashfire",
        "item": "lifeorb",
        "pokeball": "pokeball",
        "ability": "flashfire"
      },
      {
        "ident": "p2: Reuniclus",
        "details": "Reuniclus, L78, M",
        "condition": "300/300",
        "active": false,
        "stats": {
          "atk": 106,
          "def": 162,
          "spa": 240,
          "spd": 178,
          "spe": 92
        },
        "moves": [
          "shadowball",
          "recover",
          "calmmind",
          "psyshock"
        ],
        "baseAbility": "magicguard",
        "item": "lifeorb",
        "pokeball": "pokeball",
        "ability": "magicguard"
      },
      {
        "ident": "p2: Minun",
        "details": "Minun, L83, F",
        "condition": "235/235",
        "active": false,
        "stats": {
          "atk": 71,
          "def": 131,
          "spa": 172,
          "spd": 189,
          "spe": 205
        },
        "moves": [
          "hiddenpowerice60",
          "nastyplot",
          "substitute",
          "thunderbolt"
        ],
        "baseAbility": "voltabsorb",
        "item": "leftovers",
        "pokeball": "pokeball",
        "ability": "voltabsorb"
      },
      {
        "ident": "p2: Gligar",
        "details": "Gligar, L79, M",
        "condition": "232/232",
        "active": false,
        "stats": {
          "atk": 164,
          "def": 211,
          "spa": 101,
          "spd": 148,
          "spe": 180
        },
        "moves": [
          "toxic",
          "stealthrock",
          "roost",
          "earthquake"
        ],
        "baseAbility": "hypercutter",
        "item": "eviolite",
        "pokeball": "pokeball",
        "ability": "hypercutter"
      }
    ]
  },
  "rqid": 3
}
```

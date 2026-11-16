Pokémon Showdown
========================================================================

Navigation: [Website][1] | **Server repository** | [Client repository][2] | [Dex repository][3]

  [1]: http://pokemonshowdown.com/
  [2]: https://github.com/smogon/pokemon-showdown-client
  [3]: https://github.com/Zarel/Pokemon-Showdown-Dex

[![Build Status](https://github.com/smogon/pokemon-showdown/workflows/Node.js%20CI/badge.svg)](https://github.com/smogon/pokemon-showdown/actions?query=workflow%3A%22Node.js+CI%22)
[![Dependency Status](https://img.shields.io/librariesio/github/smogon/pokemon-showdown)](https://libraries.io/github/smogon/pokemon-showdown)


Introduction
------------------------------------------------------------------------

Pokémon Showdown is many things:

- A **website** you can use for Pokémon battling

  - http://pokemonshowdown.com/

- A **JavaScript library** for simulating Pokémon battles and getting Pokédex data

  - [sim/README.md](./sim/README.md)

- Some **command-line tools** for simulating Pokémon battles (which can be used in non-JavaScript programs)

  - [COMMANDLINE.md](./COMMANDLINE.md)

- A **web API** for the web site for Pokémon battling

  - [pokemon-showdown-client: WEB-API.md](https://github.com/smogon/pokemon-showdown-client/blob/master/WEB-API.md)

- A **game server** for hosting your own Pokémon Showdown community and game modes

  - [server/README.md](./server/README.md)

Pokémon Showdown simulates singles, doubles and triples battles in all the games out so far (Generations 1 through 9).

### Standalone engine build

Run `npm ci` and `npm run build:engine` to generate `.engine-dist/`.
With Node.js 22.18.0 or later, load `.engine-dist/sim/engine-battle-stream.js` to use
`EngineBattleStream`. The output includes the simulator, battle data and its runtime dependency.

Run `npm run package:engine` to build and create `.engine-package/nomelat-engine.zip` and
`.engine-package/engine.json`. Packaging uses Windows' `tar.exe` or `zip` on other platforms.
The manifest is also inside the ZIP. Increment `engineVersion` in `tools/engine.json` for each
released engine package, and increment `protocolVersion` for incompatible changes to the
[host protocol](./sim/SIM-PROTOCOL.md#standalone-engine-protocol-for-hytale).
Hytale can compare the external manifest with the installed one before extracting and check
that the plugin supports the protocol version. The ZIP includes a root `index.js` entry point for
GraalJS. Evaluating it returns a factory that accepts file and randomness functions provided by the
Java host. The factory exposes `startBattle(id, commands)`, `sendBattleMessage(id, commands)` and
`endBattle(id)`. Commands use the same newline-delimited protocol as `EngineBattleStream`. The
first two calls return the output frames produced by the command batch.
The build also includes the Nomelat translators under `nomelat/`. The host can call
`replaceAssets(json)` with the complete `{moves, abilities}` catalog to publish it atomically.
`getAssetIds()` returns the published asset-to-engine ID mappings as JSON. Use those IDs and
`format.mod: "orbisforge"` for new battles using Nomelat assets. Existing battles retain the registry
that was current when they started.
The ZIP also includes `showdown-ids.json`, generated from the packaged Gen 9 Dex. The asset editor
can read these native move, ability, species and item IDs before starting GraalJS.

Use `npm start` to run the web server for manual testing.


Documentation quick links
------------------------------------------------------------------------

* [PROTOCOL.md][4] - How the client and server communicate with each other.
* [sim/SIM-PROTOCOL.md][5] - The part of the protocol used for battles and battle messages.
* [CONTRIBUTING.md][6] - Useful code standards to understand if you want to send pull requests to PS (not necessary if you're just using the code and not planning to contribute back).
* [ARCHITECTURE.md][7] - A high-level overview of how the code works.
* [Bot FAQ][8] - An FAQ compiled by Kaiepi regarding making Pokemon Showdown bots - mainly chatbots and battle bots.

  [4]: ./PROTOCOL.md
  [5]: ./sim/SIM-PROTOCOL.md
  [6]: ./CONTRIBUTING.md
  [7]: ./ARCHITECTURE.md
  [8]: https://gist.github.com/Kaiepi/becc5d0ecd576f5e7733b57b4e3fa97e


Community
------------------------------------------------------------------------

PS has a built-in chat service. Join our main server to talk to us!

You can also visit the [Pokémon Showdown forums][9] for discussion and help.

  [9]: https://www.smogon.com/forums/forums/pok%C3%A9mon-showdown.209/

If you'd like to contribute to programming and don't know where to start, feel free to check out [Ideas for New Developers][10].

  [10]: https://github.com/smogon/pokemon-showdown/issues/2444


License
------------------------------------------------------------------------

Pokémon Showdown's server is distributed under the terms of the [MIT License][11].

  [11]: ./LICENSE


Credits
------------------------------------------------------------------------

Owner

- Guangcong Luo [Zarel] - Development, Design, Sysadmin

Staff

- Andrew Werner [HoeenHero] - Development
- Annika L. [Annika] - Development
- Chris Monsanto [chaos] - Development, Sysadmin
- Kris Johnson [dhelmise] - Development
- Leonard Craft III [DaWoblefet] - Research (game mechanics)
- Mathieu Dias-Martins [Marty-D] - Research (game mechanics), Development
- Mia A [Cassiopeia] - Development

Contributors

- See http://pokemonshowdown.com/credits

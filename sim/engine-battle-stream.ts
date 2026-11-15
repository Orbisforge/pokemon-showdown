import { Battle } from './battle';
import { BattleStream } from './battle-stream';
import { Dex } from './dex';
import type { EngineDex } from './engine-dex';
import { exportPokemonState, restorePokemonState, type EnginePokemonState } from './engine-pokemon-state';
import type { Pokemon } from './pokemon';
import type { Side } from './side';
import { Teams } from './teams';

const GAME_TYPES = ['singles', 'doubles', 'triples', 'multi', 'freeforall'];

interface EnginePlayerOptions extends PlayerOptions {
	pokemonState?: EnginePokemonState[];
}

// Retain the original roster when Team Preview changes the order or picks a subset.
const rosters = new WeakMap<Side, { id: string, pokemon: Pokemon }[]>();

class EngineBattle extends Battle {
	protected override createSide(slotNum: number, options: EnginePlayerOptions) {
		const side = super.createSide(slotNum, options);
		const states = options.pokemonState;
		if (states !== undefined && (!Array.isArray(states) || states.length !== side.pokemon.length)) {
			throw new Error(`Expected one Pokemon state per team member for ${side.id}`);
		}
		const ids = new Set(this.sides.flatMap(player => (rosters.get(player) ?? []).map(entry => entry.id)));
		const roster = side.pokemon.map((pokemon, index) => {
			const state = states?.[index];
			const id = states ? state?.id : `${side.id}:${index + 1}`;
			if (typeof id !== 'string' || !id.trim() || ids.has(id)) {
				throw new Error(`Expected a unique Pokemon ID for ${side.id} at position ${index + 1}`);
			}
			ids.add(id);
			if (state) restorePokemonState(pokemon, state);
			return { id, pokemon };
		});
		rosters.set(side, roster);
		return side;
	}

	override setPlayer(slot: SideID, options: EnginePlayerOptions) {
		const slots = ['p1', 'p2', 'p3', 'p4'].slice(0, this.format.playerCount);
		if (!slots.includes(slot)) throw new Error(`Invalid player slot ${slot} for ${this.gameType}`);
		const side = this.sides[slots.indexOf(slot)];
		if (!side && !options?.team) {
			throw new Error(`Player ${slot} requires an explicit team`);
		}
		if (side && options.pokemonState !== undefined) throw new Error(`Player ${slot} already has Pokemon state`);
		super.setPlayer(slot, options);
	}

	override getTeam(options: PlayerOptions) {
		const team = typeof options.team === 'string' ? Teams.unpack(options.team) : options.team;
		if (!Array.isArray(team) || !team.length) throw new Error('Expected a nonempty explicit team');
		return team;
	}
}

/** Runs a battle configured by the host, with teams supplied by the host. */
export class EngineBattleStream extends BattleStream {
	readonly engineDex?: EngineDex;

	constructor(options: NonNullable<ConstructorParameters<typeof BattleStream>[0]> & { engineDex?: EngineDex } = {}) {
		super(options);
		this.engineDex = options.engineDex;
	}

	protected override createBattle(options: ConstructorParameters<typeof Battle>[0]) {
		const rawFormat: unknown = options.format;
		if (!rawFormat || typeof rawFormat !== 'object' || Array.isArray(rawFormat)) {
			throw new Error('Expected an explicit battle format in >start');
		}
		const { name, mod, gameType, ruleset, gen } = rawFormat as Record<string, unknown>;
		const engineDex = this.engineDex?.dex;
		const dex = typeof mod === 'string' && (mod === engineDex?.currentMod ? engineDex :
			Object.hasOwn(Dex.dexes, mod) ? Dex.mod(mod) : undefined);
		if (!dex) {
			throw new Error('Expected a known Dex mod in the battle format');
		}
		if (typeof gameType !== 'string' || !GAME_TYPES.includes(gameType)) {
			throw new Error('Expected a supported gameType in the battle format');
		}
		if (!Array.isArray(ruleset) || ruleset.some(rule => typeof rule !== 'string')) {
			throw new Error('Expected a ruleset array of strings in the battle format');
		}
		if (name !== undefined && (typeof name !== 'string' || !Dex.toID(name))) {
			throw new Error('Expected a valid name in the battle format');
		}
		if (gen !== undefined && gen !== dex.gen) {
			throw new Error('Battle format generation must match its Dex mod');
		}

		const formatData = { name: name ?? `Orbisforge ${gameType}`, mod, gameType, ruleset, effectType: 'Format' };
		const format = new Dex.Format(formatData);
		const battle = new EngineBattle({ ...options, format, formatid: format.id }, dex);
		// Replay through this stream with the same rules, even when the format has no catalog entry.
		const start = battle.inputLog.findIndex(line => line.startsWith('>start '));
		const startOptions = JSON.parse(battle.inputLog[start].slice('>start '.length));
		battle.inputLog[start] = `>start ${JSON.stringify({ ...startOptions, format: formatData })}`;
		return battle;
	}

	override pushMessage(type: string, data: string) {
		if (type === 'end' && this.battle) {
			const pokemonState = Object.fromEntries(this.battle.sides.map(side => [
				side.id, rosters.get(side)?.map(({ id, pokemon }) => exportPokemonState(id, pokemon)) ?? [],
			]));
			data = JSON.stringify({ ...JSON.parse(data), pokemonState });
		}
		super.pushMessage(type, data);
	}
}

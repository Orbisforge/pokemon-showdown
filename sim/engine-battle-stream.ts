import { Battle } from './battle';
import { BattleStream } from './battle-stream';
import { Dex } from './dex';
import { useEngineBagItem } from './engine-bag-items';
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
	readonly capturedPokemon: EnginePokemonState[] = [];
	readonly wildSide?: SideID;
	private escapedSide?: SideID;
	private readonly forfeitedSides = new Set<SideID>();
	declare private winningSides?: SideID[];
	private endedByForfeit = false;

	constructor(options: ConstructorParameters<typeof Battle>[0], dex: ConstructorParameters<typeof Battle>[1], wildSide?: SideID) {
		super(options, dex);
		this.wildSide = wildSide;
	}

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

	private requireActiveBattle() {
		if (!this.started || this.ended || this.turn < 1) throw new Error('Expected an active battle');
	}

	useBagItem(input: unknown) {
		this.requireActiveBattle();
		if (this.requestState !== 'move') throw new Error('Bag items require a move request');
		if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Expected a bag item command');
		const { side, item, target, moveSlot } = input as Record<string, unknown>;
		if (typeof side !== 'string' || typeof item !== 'string' || typeof target !== 'string' ||
			(moveSlot !== undefined && (typeof moveSlot !== 'number' || !Number.isInteger(moveSlot) || moveSlot < 1))) {
			throw new Error('Expected side, item, target and an optional moveSlot in >useitem');
		}
		const player = this.sides.find(candidate => candidate.id === side);
		const pokemon = player && rosters.get(player)?.find(entry => entry.id === target)?.pokemon;
		if (!player || !pokemon || !player.pokemon.includes(pokemon) ||
			this.capturedPokemon.some(entry => entry.id === target)) {
			throw new Error('The bag item must target a Pokemon on the specified player’s battle team');
		}
		if (player.requestState !== 'move') throw new Error('The specified player is not choosing a move');
		const itemId = Dex.toID(item);
		const applied = useEngineBagItem(itemId, pokemon, moveSlot);
		if (applied) {
			this.inputLog.push(`>useitem ${JSON.stringify({ side, item: itemId, target, moveSlot })}`);
			this.add('bagitem', player.id, pokemon, itemId);
			for (const recipient of [player, player.allySide]) {
				const request = recipient?.activeRequest;
				if (!recipient || !request) continue;
				const updated = { ...request, side: recipient.getRequestData() };
				if ('active' in updated) {
					updated.active = recipient.active.map(member => member?.getMoveRequestData());
					if (recipient.allySide) updated.ally = recipient.allySide.getRequestData(true);
					updated.update = true;
				}
				recipient.emitRequest(updated);
			}
		}
		return { side, item: itemId, target, applied, pokemonState: exportPokemonState(target, pokemon) };
	}

	/** Reports simulator state for the host. Hidden sources should stay server-side. */
	getTrappingState() {
		this.requireActiveBattle();
		const ids = new Map(this.sides.flatMap(side => (rosters.get(side) ?? []).map(({ id, pokemon }) => [pokemon, id] as const)));
		return this.sides.flatMap(side => side.active.flatMap(pokemon => {
			if (!pokemon?.hp || pokemon.fainted) return [];
			return [{
				id: ids.get(pokemon),
				side: side.id,
				switchBlocked: !!pokemon.trapped,
				sources: pokemon.getTrapSources().map(({ effect, state, hidden }) => ({
					id: effect.id,
					name: effect.name,
					type: effect.effectType,
					causeId: state.sourceEffect?.id ?? effect.id,
					causeName: state.sourceEffect?.name ?? effect.name,
					sourcePokemonId: ids.get(state.source ?? state.target),
					remainingTurns: state.duration,
					hidden,
				})),
			}];
		}));
	}

	confirmEscape(id: string) {
		if (!this.wildSide) return 'not-wild-encounter';
		if (!this.started || this.ended || this.turn < 1) return 'battle-not-active';
		const side = this.sides.find(candidate => candidate.id === id);
		const wild = this.getSide(this.wildSide);
		if (!side?.pokemonLeft || side === wild || side === wild.allySide) return 'invalid-player-side';
		this.escapedSide = side.id;
		this.winner = '';
		this.inputLog.push(`>escape ${side.id}`);
		this.add('escape', side.id);
		this.finishBattle();
		return null;
	}

	override win(side?: SideID | '' | Side | null) {
		const winner = typeof side === 'string' && side ? this.getSide(side) : side;
		const ended = super.win(side);
		if (ended && winner && this.sides.includes(winner)) {
			this.winningSides = this.sides.filter(player => player === winner || player === winner.allySide)
				.map(player => player.id);
		}
		return ended;
	}

	closeFromHost(type: 'forcelose' | 'forcetie' | 'forcewin', id: string) {
		if (!this.started || this.ended) throw new Error('Expected a battle in progress');
		const side = this.sides.find(player => player.id === id);
		if (type === 'forcetie') {
			if (id) throw new Error('>forcetie does not take arguments');
			this.inputLog.push('>forcetie');
			this.tie();
			return;
		}
		if (!side?.pokemonLeft) throw new Error(`Expected a participating side in >${type}`);
		this.inputLog.push(`>${type} ${side.id}`);
		if (type === 'forcewin') {
			this.win(side);
			return;
		}
		this.forfeitedSides.add(side.id);
		this.add('forfeit', side.id);
		// In Free-for-All an early forfeit only eliminates that participant.
		this.endedByForfeit = this.gameType !== 'freeforall' || this.sides.filter(player => player.pokemonLeft).length === 2;
		this.lose(side);
		if (!this.ended) this.endedByForfeit = false;
	}

	getOutcome() {
		const winningSides = this.winningSides ?? [];
		const reason = this.escapedSide ? 'escape' : winningSides.length ?
			(this.endedByForfeit ? 'forfeit' : 'victory') : 'tie';
		const losingSides = winningSides.length ?
			this.sides.map(side => side.id).filter(id => !winningSides.includes(id)) : [];
		return {
			reason,
			winningSides,
			losingSides,
			forfeitedSides: [...this.forfeitedSides],
			...(this.escapedSide ? { escapedSide: this.escapedSide } : {}),
		};
	}

	capturePokemon(capturingSideId: SideID, id: string) {
		this.requireActiveBattle();
		if (this.gameType !== 'singles' || !this.wildSide) {
			throw new Error('Capture is only supported in wild Singles encounters');
		}
		const wild = this.getSide(this.wildSide);
		const capturingSide = this.getSide(capturingSideId);
		if (capturingSide !== wild.foe) throw new Error('Only the player facing the wild Pokemon can capture it');
		const pokemon = wild.active[0];
		if (!pokemon?.hp || pokemon.fainted || !rosters.get(wild)?.some(entry => entry.pokemon === pokemon && entry.id === id)) {
			throw new Error('The capture target must be the active wild Pokemon');
		}
		if (wild.pokemonLeft !== 1) throw new Error('Capture requires exactly one living wild Pokemon');

		this.inputLog.push(`>capture ${capturingSideId} ${id}`);
		this.capturedPokemon.push(exportPokemonState(id, pokemon));
		this.add('capture', pokemon, id);
		wild.pokemonLeft = 0;
		wild.active[0] = null!;
		pokemon.isActive = false;
		this.checkWin();
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
		const { wildSide } = options as typeof options & { wildSide?: unknown };
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
		const playerSlots = ['p1', 'p2', 'p3', 'p4'].slice(0, format.playerCount);
		if (wildSide !== undefined &&
			(typeof wildSide !== 'string' || !playerSlots.includes(wildSide) || gameType === 'freeforall')) {
			throw new Error('Expected a valid wild side in a two-team encounter');
		}
		const battle = new EngineBattle({ ...options, format, formatid: format.id }, dex, wildSide as SideID | undefined);
		// Replay through this stream with the same rules, even when the format has no catalog entry.
		const start = battle.inputLog.findIndex(line => line.startsWith('>start '));
		const startOptions = JSON.parse(battle.inputLog[start].slice('>start '.length));
		battle.inputLog[start] = `>start ${JSON.stringify({ ...startOptions, format: formatData, wildSide })}`;
		return battle;
	}

	override _writeLine(type: string, message: string) {
		if (type === 'eval' || type === 'editbattle') {
			throw new Error(`>${type} is unavailable on EngineBattleStream`);
		}
		if (type === 'forcelose' || type === 'forcetie' || type === 'forcewin') {
			if (!(this.battle instanceof EngineBattle)) throw new Error(`Start the battle before using >${type}`);
			this.battle.closeFromHost(type, message);
			return;
		}
		if (type === 'useitem' || type === 'trapstate' || type === 'escape') {
			const battle = this.battle;
			if (!(battle instanceof EngineBattle)) throw new Error(`Start the battle before using >${type}`);
			if (type === 'useitem') {
				this.pushMessage('bagitem', JSON.stringify(battle.useBagItem(JSON.parse(message))));
			} else if (type === 'trapstate') {
				if (message) throw new Error('>trapstate does not take arguments');
				this.pushMessage('trapstate', JSON.stringify(battle.getTrappingState()));
			} else {
				const reason = battle.confirmEscape(message);
				if (reason) this.pushMessage('escape', JSON.stringify({ side: message, applied: false, reason }));
			}
			return;
		}
		if (type === 'capture') {
			if (!(this.battle instanceof EngineBattle)) throw new Error('Start the battle before capturing Pokemon');
			const match = /^(p[1-4]) ([^\s]+)$/.exec(message);
			if (!match) throw new Error('Expected a side and Pokemon ID in >capture');
			this.battle.capturePokemon(match[1] as SideID, match[2]);
			return;
		}
		super._writeLine(type, message);
	}

	override pushMessage(type: string, data: string) {
		if (type === 'end' && this.battle) {
			const engineBattle = this.battle as EngineBattle;
			const capturedIds = new Set(engineBattle.capturedPokemon.map(pokemon => pokemon.id));
			const pokemonState = Object.fromEntries(this.battle.sides.map(side => [
				side.id, rosters.get(side)?.filter(({ id }) => !capturedIds.has(id))
					.map(({ id, pokemon }) => exportPokemonState(id, pokemon)) ?? [],
			]));
			data = JSON.stringify({
				...JSON.parse(data), ...engineBattle.getOutcome(), pokemonState, capturedPokemon: engineBattle.capturedPokemon,
			});
		}
		super.pushMessage(type, data);
	}
}

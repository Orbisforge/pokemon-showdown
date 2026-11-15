import type { Pokemon } from './pokemon';

const STATUSES = ['', 'brn', 'frz', 'par', 'psn', 'slp', 'tox'];

export interface EnginePokemonState {
	id: string;
	hp?: number;
	status?: string;
	sleepTurns?: number;
	/** Remaining PP in the same order as the supplied moves. */
	pp?: number[];
}

export function restorePokemonState(pokemon: Pokemon, state: EnginePokemonState) {
	const { id, hp, status = '', sleepTurns, pp } = state;
	if (hp !== undefined && (!Number.isInteger(hp) || hp < 1 || hp > pokemon.maxhp)) {
		throw new Error(`Invalid HP for ${id}: expected 1 to ${pokemon.maxhp}`);
	}
	if (!STATUSES.includes(status)) throw new Error(`Invalid status for ${id}: ${status}`);
	if (status === 'slp') {
		if (sleepTurns === undefined || !Number.isInteger(sleepTurns) || sleepTurns < 1) {
			throw new Error(`Expected positive sleepTurns for ${id}`);
		}
	} else if (sleepTurns !== undefined) {
		throw new Error(`sleepTurns requires sleep status for ${id}`);
	}
	if (pp !== undefined && (!Array.isArray(pp) || pp.length !== pokemon.baseMoveSlots.length ||
		pp.some((value, index) => !Number.isInteger(value) || value < 0 || value > pokemon.baseMoveSlots[index].maxpp))) {
		throw new Error(`Invalid PP for ${id}: supply remaining PP for each move in team order`);
	}

	if (hp !== undefined) pokemon.hp = hp;
	if (status) {
		const condition = pokemon.battle.dex.conditions.get(status);
		const effectState = pokemon.battle.initEffectState({ id: condition.id, target: pokemon });
		if (status === 'slp') effectState.time = effectState.startTime = sleepTurns;
		if (status === 'tox') effectState.stage = 0;
		pokemon.status = condition.id;
		pokemon.statusState = effectState;
	}
	if (pp) pokemon.baseMoveSlots.forEach((move, index) => { move.pp = pp[index]; });
}

export function exportPokemonState(id: string, pokemon: Pokemon) {
	return {
		id,
		hp: pokemon.getUndynamaxedHP(),
		maxHp: pokemon.baseMaxhp,
		status: pokemon.fainted ? '' : pokemon.status,
		...(pokemon.status === 'slp' && !pokemon.fainted ? { sleepTurns: pokemon.statusState.time } : {}),
		pp: pokemon.baseMoveSlots.map(move => move.pp),
	};
}

import type { Pokemon } from './pokemon';

interface BagItem {
	heal?: number;
	cure?: string;
	revive?: number;
	pp?: number;
	allMoves?: boolean;
	boost?: BoostID;
	condition?: 'focusenergy' | 'mist';
}

const bagItems: Readonly<Record<string, BagItem>> = {
	potion: { heal: 20 },
	superpotion: { heal: 60 },
	hyperpotion: { heal: 120 },
	maxpotion: { heal: Infinity },
	fullrestore: { heal: Infinity, cure: 'any' },
	antidote: { cure: 'poison' },
	burnheal: { cure: 'brn' },
	iceheal: { cure: 'frz' },
	awakening: { cure: 'slp' },
	paralyzeheal: { cure: 'par' },
	fullheal: { cure: 'any' },
	revive: { revive: 0.5 },
	maxrevive: { revive: 1 },
	ether: { pp: 10 },
	maxether: { pp: Infinity },
	elixir: { pp: 10, allMoves: true },
	maxelixir: { pp: Infinity, allMoves: true },
	xattack: { boost: 'atk' },
	xdefense: { boost: 'def' },
	xdefence: { boost: 'def' },
	xspecialattack: { boost: 'spa' },
	xspecialdefense: { boost: 'spd' },
	xspecialdefence: { boost: 'spd' },
	xspeed: { boost: 'spe' },
	xaccuracy: { boost: 'accuracy' },
	direhit: { condition: 'focusenergy' },
	guardspec: { condition: 'mist' },
};

/** Applies a built-in bag item. Returns whether it changed the battle state. */
export function useEngineBagItem(item: string, pokemon: Pokemon, moveSlot?: number) {
	if (!Object.hasOwn(bagItems, item)) throw new Error(`Unknown bag item: ${item}`);
	const medicine = bagItems[item];
	const { battle } = pokemon;
	if (moveSlot !== undefined && (!medicine.pp || medicine.allMoves)) {
		throw new Error('This item does not take a move slot');
	}
	if (medicine.revive) {
		// A fainted battler still occupying a field slot needs a replacement first.
		if (!pokemon.fainted || pokemon.side.active.includes(pokemon)) return false;
		pokemon.fainted = pokemon.faintQueued = pokemon.subFainted = false;
		pokemon.hp = Math.max(1, Math.floor(pokemon.maxhp * medicine.revive));
		pokemon.clearStatus();
		pokemon.side.pokemonLeft++;
		battle.add('-heal', pokemon, pokemon.getHealth, `[from] bag item: ${item}`);
		return true;
	}
	if (!pokemon.hp || pokemon.fainted) return false;
	if (medicine.boost || medicine.condition) {
		if (!pokemon.isActive) return false;
		const effect = battle.dex.items.get(item);
		if (medicine.boost) return !!battle.boost({ [medicine.boost]: 1 }, pokemon, pokemon, effect);
		if (medicine.condition === 'mist') return pokemon.side.addSideCondition('mist', pokemon, effect);
		return pokemon.addVolatile('focusenergy', pokemon, effect);
	}
	if (medicine.pp) {
		const slots = medicine.allMoves ? pokemon.baseMoveSlots :
			moveSlot === undefined ? [] : [pokemon.baseMoveSlots[moveSlot - 1]];
		if (!slots.length || !slots[0]) throw new Error('Expected a valid move slot starting at 1');
		let restored = false;
		for (const slot of slots) {
			if (slot.pp === slot.maxpp) continue;
			slot.pp = Math.min(slot.maxpp, slot.pp + medicine.pp);
			restored = true;
		}
		return restored;
	}
	let changed = false;
	if (medicine.heal && pokemon.heal(Math.min(pokemon.maxhp, medicine.heal))) {
		battle.add('-heal', pokemon, pokemon.getHealth, `[from] bag item: ${item}`);
		changed = true;
	}
	if (medicine.cure === 'any' || medicine.cure === pokemon.status ||
		(medicine.cure === 'poison' && ['psn', 'tox'].includes(pokemon.status))) {
		changed = pokemon.cureStatus() || changed;
	}
	if (medicine.cure === 'any') changed = pokemon.removeVolatile('confusion') || changed;
	return changed;
}

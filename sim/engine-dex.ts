import { Dex, ModdedDex, toID } from './dex';

type DexData = ModdedDex['data'];
type Entries<T> = Record<string, Partial<T>>;

export interface EngineDexData {
	species?: Entries<DexData['Pokedex'][string]>;
	moves?: Entries<DexData['Moves'][string]>;
	natures?: Entries<DexData['Natures'][string]>;
	abilities?: Entries<DexData['Abilities'][string]>;
	items?: Entries<DexData['Items'][string]>;
}

function overlay<T extends { name: string }>(base: Record<string, T>, entries?: Entries<T>): Record<string, T> {
	const table = { ...base };
	const ids = new Set<ID>();
	for (const [key, entry] of Object.entries(entries ?? {})) {
		const id = toID(key);
		if (!id || id === 'constructor' || Dex.getAlias(id) || ids.has(id)) {
			throw new Error(`Invalid or duplicate Dex entry ID: ${key}`);
		}
		ids.add(id);
		if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
			throw new Error(`Expected a data object for Dex entry ${key}`);
		}
		const merged = Dex.deepClone({ ...base[id], ...entry }) as T;
		if (typeof merged.name !== 'string' || toID(merged.name) !== id) {
			throw new Error(`Dex entry ${key} must have a matching name`);
		}
		table[id] = Dex.deepFreeze(merged);
	}
	return table;
}

class EngineModdedDex extends ModdedDex {
	constructor(parent: ModdedDex, previous: ModdedDex, entries: EngineDexData) {
		super('orbisforge');
		this.gen = parent.gen;
		this.parentMod = parent.currentMod;
		this.dataCache = {
			...parent.data,
			Pokedex: overlay(previous.data.Pokedex, entries.species),
			Moves: overlay(previous.data.Moves, entries.moves),
			Natures: overlay(previous.data.Natures, entries.natures),
			Abilities: overlay(previous.data.Abilities, entries.abilities),
			Items: overlay(previous.data.Items, entries.items),
		};
	}

	override mod(mod: string | undefined): ModdedDex {
		return mod === this.currentMod ? this : super.mod(mod);
	}
}

/** A registry for one host. Registering a batch replaces its Dex for subsequent battles. */
export class EngineDex {
	readonly #parent: ModdedDex;
	#dex: ModdedDex;

	constructor(parentMod = 'gen9') {
		if (!Object.hasOwn(Dex.dexes, parentMod)) throw new Error(`Unknown parent Dex mod: ${parentMod}`);
		this.#parent = Dex.mod(parentMod);
		this.#dex = new EngineModdedDex(this.#parent, this.#parent, {});
	}

	get dex(): ModdedDex {
		return this.#dex;
	}

	register(entries: EngineDexData): ModdedDex {
		return (this.#dex = new EngineModdedDex(this.#parent, this.#dex, entries));
	}
}

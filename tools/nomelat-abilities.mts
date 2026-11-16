import type { Battle } from '../sim/battle.ts';
import type { AbilityData } from '../sim/dex-abilities.ts';
import type { ActiveMove } from '../sim/dex-moves.ts';
import type { EngineDex } from '../sim/engine-dex.ts';
import type { Pokemon } from '../sim/pokemon.ts';
import { translateNomelatMove } from './nomelat-moves.mts';

type Fields = Record<string, unknown>;
type RegistryFactory = () => EngineDex;
type Timing = { Priority?: number, Order?: number, SubOrder?: number };
type AbilityHook = (this: Battle, ...args: any[]) => unknown;
type Abilities = Record<string, AbilityData>;
type CompiledAbility = Omit<AbilityData, 'condition'> & { condition?: AbilityData['condition'] };

const toID = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '');
const elements = ['Normal', 'Fire', 'Water', 'Electric', 'Grass', 'Ice', 'Fighting', 'Poison', 'Ground',
	'Flying', 'Psychic', 'Bug', 'Rock', 'Ghost', 'Dragon', 'Dark', 'Steel', 'Fairy', 'Stellar', '???'];
const weathers = ['desolateland', 'deltastream', 'hail', 'primordialsea', 'raindance', 'sandstorm', 'snowscape', 'sunnyday'];
const terrains = ['electricterrain', 'grassyterrain', 'mistyterrain', 'psychicterrain'];
const statuses = new Map([['Burn', 'brn'], ['Freeze', 'frz'], ['Paralysis', 'par'], ['Poison', 'psn'],
	['BadPoison', 'tox'], ['Sleep', 'slp']]);
const flags = ['breakable', 'cantsuppress', 'failroleplay', 'failskillswap', 'noentrain', 'noreceiver', 'notrace', 'notransform'];
const categories = ['Physical', 'Special', 'Status'];
const moveFlags = ['allyanim', 'bite', 'bullet', 'charge', 'contact', 'dance', 'heal', 'powder', 'pulse',
	'pledgecombo', 'punch', 'recharge', 'reflectable', 'slicing', 'sound', 'wind'];
const stats = new Map([['Attack', 'atk'], ['Defense', 'def'], ['SpecialAttack', 'spa'], ['SpecialDefense', 'spd'],
	['Speed', 'spe'], ['Accuracy', 'accuracy'], ['Evasion', 'evasion']] as const);
const modifierEvents = ['ModifyAttack', 'ModifyDefense', 'ModifySpecialAttack', 'ModifySpecialDefense', 'ModifySpeed',
	'ModifyIncomingAttack', 'ModifyIncomingSpecialAttack', 'ModifyBasePower', 'ModifyIncomingBasePower', 'ModifyAllyBasePower',
	'ModifyDamage', 'ModifyIncomingDamage', 'ModifyAccuracy', 'ModifyOutgoingAccuracy', 'ModifyWeight', 'ModifyCriticalRatio',
	'ModifyPriority', 'ModifyFractionalPriority', 'ModifySTAB', 'ModifyWeatherDamage', 'ModifyResidualDamage',
	'ModifyAnyDamage', 'ModifyAnyAccuracy', 'ModifyAllyAttack', 'ModifyAllySpecialDefense'] as const;
const modifierHooks = ['onModifyAtk', 'onModifyDef', 'onModifySpA', 'onModifySpD', 'onModifySpe',
	'onSourceModifyAtk', 'onSourceModifySpA', 'onBasePower', 'onSourceBasePower', 'onAllyBasePower',
	'onModifyDamage', 'onSourceModifyDamage', 'onModifyAccuracy', 'onSourceModifyAccuracy', 'onModifyWeight',
	'onModifyCritRatio', 'onModifyPriority', 'onFractionalPriority', 'onModifySTAB', 'onWeatherModifyDamage', 'onDamage',
	'onAnyModifyDamage', 'onAnyModifyAccuracy', 'onAllyModifyAtk', 'onAllyModifySpD'] as const;
const pokemonEvents = ['Start', 'SwitchIn', 'SwitchOut', 'EndOfTurn', 'AfterItemEaten', 'AfterTakingDamage',
	'AfterDealingDamage', 'AfterKnockout', 'AfterAnyFaint', 'OnFlinch', 'OnWeather', 'AfterTerastallization', 'OnHit', 'Update',
	'SideConditionStart', 'AfterMoveSecondary', 'BeforeMove', 'WeatherChange', 'AfterStatChange'] as const;
const pokemonHooks = ['onStart', 'onSwitchIn', 'onSwitchOut', 'onResidual', 'onEatItem', 'onDamagingHit',
	'onSourceDamagingHit', 'onSourceAfterFaint', 'onAnyFaint', 'onFlinch', 'onWeather', 'onAfterTerastallization', 'onHit', 'onUpdate',
	'onSideConditionStart', 'onAfterMoveSecondary', 'onBeforeMove', 'onWeatherChange', 'onAfterBoost'] as const;
const engineRules = new Map([
	['levitate', 'GroundImmunity'], ['corrosion', 'PoisonTypeImmunityBypass'], ['dancer', 'CopyDanceMoves'],
	['earlybird', 'DoubleSleepCountdown'], ['multitype', 'TypeFromPlate'], ['rkssystem', 'TypeFromMemory'],
	['terashell', 'FullHPTypeResistance'], ['klutz', 'DisableHeldItemEffects'],
]);

function fail(path: string, message: string): never { throw new Error(`${path}: ${message}`); }

function object(value: unknown, path: string, keys?: readonly string[]): Fields {
	if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, 'expected an object');
	const fields = value as Fields;
	for (const key of Object.keys(fields)) {
		if (keys && !keys.includes(key)) fail(`${path}.${key}`, 'unknown field');
	}
	return fields;
}

function choice<T extends string>(value: unknown, options: readonly T[], path: string): T {
	const result = options.find(option => option === value);
	if (result === undefined) fail(path, `unknown option ${String(value)}`);
	return result;
}

function list(value: unknown, path: string): unknown[] {
	if (!Array.isArray(value)) fail(path, 'expected a list');
	return value;
}

function choices<T extends string>(value: unknown, options: readonly T[], path: string): T[] {
	const result = list(value, path).map((entry, index) => choice(entry, options, `${path}[${index}]`));
	if (!result.length || new Set(result).size !== result.length) fail(path, 'expected distinct options');
	return result;
}

function number(value: unknown, path: string, min: number, max: number, integral = false): number {
	if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integral && !Number.isInteger(value))) {
		fail(path, `expected ${integral ? 'an integer' : 'a number'} from ${min} to ${max}`);
	}
	return value;
}

function optionalBoolean(value: unknown, path: string): boolean {
	if (value === undefined) return false;
	if (typeof value !== 'boolean') fail(path, 'expected a boolean');
	return value;
}

function fraction(value: unknown, path: string, maxNumerator = Number.MAX_SAFE_INTEGER): [number, number] {
	const fields = object(value, path, ['Numerator', 'Denominator']);
	return [number(fields.Numerator, `${path}.Numerator`, 0, maxNumerator, true),
		number(fields.Denominator, `${path}.Denominator`, 1, Number.MAX_SAFE_INTEGER, true)];
}

interface Context {
	holder: Pokemon;
	target?: Pokemon | null;
	source?: Pokemon | null;
	effect?: Effect | null;
	value?: number;
	count?: number;
	boosts?: SparseBoostsTable;
}

type Predicate = (battle: Battle, context: Context) => boolean;

function filters(input: unknown, path: string): Predicate {
	if (input === undefined) return () => true;
	const fields = object(input, path, ['MoveTypes', 'MoveFlags', 'MoveCategories', 'Weather', 'Terrain', 'Status',
		'HasStatus', 'AtFullHP', 'AtMostHP', 'AtLeastOneActiveTurn', 'ExternalMove', 'Contact', 'ContactAnnouncesProtection',
		'HolderFainted', 'CriticalHit', 'SuperEffective', 'Resisted', 'MaximumEffectivePower', 'AbilityNotSuppressed',
		'SwitchingTarget', 'Grounded', 'DamageEffect', 'HolderTypes', 'TargetIsAlly', 'TargetHasNotTakenTurn',
		'HasRecoil', 'MovesLast', 'EffectiveWeatherOnly', 'AgainstDifferentPokemon', 'NonMoveDamage', 'StatusMoveSTAB',
		'WithoutDynamax', 'SourceCanBeAffectedByPowder', 'FieldWeather', 'FieldTerrain', 'AffectedByPowderByType',
		'HolderNotFainted', 'HolderVolatiles', 'TargetStatus', 'AllyAbilities', 'OtherAllyIsTarget',
		'SourceIsAlly', 'UnprotectedFromSecondary', 'MoveIds', 'VolatileFromMove', 'ContactFromTarget',
		'SideCondition', 'FromSideCondition', 'Species', 'BaseSpecies', 'BaseForm', 'MinimumLevel',
		'NotTransformed', 'NotTerastallized', 'Terastallized', 'AttackerLacksVolatile', 'ExcludeMaxMove', 'BlockedFlags',
		'ExceptMoves', 'EffectAbilities', 'ChangedStats', 'HasRemainingFoes', 'BattleTargetWeather', 'DefenderTypes']);
	const checks: Predicate[] = [];
	const field = (key: string) => `${path}.${key}`;
	const inList = <T extends string>(key: string, options: readonly T[], read: (battle: Battle, context: Context) => string | undefined) => {
		if (!(key in fields)) return;
		const allowed = choices(fields[key], options, field(key));
		checks.push((battle, context) => allowed.some(value => value === read(battle, context)));
	};
	const condition = (key: string, test: Predicate) => {
		if (key in fields) {
			const expected = optionalBoolean(fields[key], field(key));
			checks.push((battle, context) => test(battle, context) === expected);
		}
	};
	const move = (context: Context) => context.effect?.effectType === 'Move' ? context.effect : undefined;
	inList('MoveTypes', elements, (_battle, context) => move(context)?.type);
	inList('MoveCategories', categories, (_battle, context) => move(context)?.category);
	inList('Weather', weathers, (_battle, { holder }) => holder.effectiveWeather());
	inList('Terrain', terrains, (battle, { holder }) => battle.field.effectiveTerrain(holder));
	inList('FieldWeather', weathers, battle => battle.field.effectiveWeather());
	inList('FieldTerrain', terrains, battle => battle.field.effectiveTerrain());
	inList('BattleTargetWeather', weathers, battle => (battle.event.target as Pokemon)?.effectiveWeather());
	inList('FromSideCondition', ['tailwind'], (_battle, { effect }) => effect?.id);
	inList('Status', [...statuses.keys()], (_battle, { holder }) => [...statuses].find(([, id]) => id === holder.status)?.[0]);
	inList('TargetStatus', [...statuses.keys()], (_battle, { target }) => [...statuses].find(([, id]) => id === target?.status)?.[0]);
	inList('DamageEffect', ['brn', 'psn', 'tox', 'recoil', 'strugglerecoil', 'Move'],
		(_battle, { effect }) => effect?.effectType === 'Move' ? 'Move' : effect?.id);
	if ('MoveFlags' in fields) {
		const required = choices(fields.MoveFlags, moveFlags, field('MoveFlags')) as (keyof Move['flags'])[];
		checks.push((_battle, context) => required.every(flag => !!move(context)?.flags[flag]));
	}
	if ('HolderTypes' in fields) {
		const types = choices(fields.HolderTypes, elements, field('HolderTypes'));
		checks.push((_battle, { holder }) => holder.hasType(types));
	}
	if ('DefenderTypes' in fields) {
		const types = choices(fields.DefenderTypes, elements, field('DefenderTypes'));
		checks.push((_battle, { target }) => !!target?.hasType(types));
	}
	if ('HolderVolatiles' in fields) {
		const required = choices(fields.HolderVolatiles, ['confusion', 'dynamax', 'leechseed', 'substitute', 'yawn'], field('HolderVolatiles'));
		checks.push((_battle, { holder }) => required.every(id => !!holder.volatiles[id]));
	}
	if ('AllyAbilities' in fields) {
		const abilities = strings(fields.AllyAbilities, field('AllyAbilities'));
		checks.push((_battle, { holder }) => holder.allies().some(ally => ally.hasAbility(abilities)));
	}
	if ('SideCondition' in fields) {
		const conditions = choices(fields.SideCondition, ['tailwind'], field('SideCondition'));
		checks.push((_battle, { holder }) => conditions.some(id => !!holder.side.getSideCondition(id)));
	}
	if ('Species' in fields) {
		const allowed = strings(fields.Species, field('Species')).map(toID);
		checks.push((_battle, { holder }) => allowed.includes(holder.species.id));
	}
	if ('BaseSpecies' in fields) {
		const allowed = strings(fields.BaseSpecies, field('BaseSpecies')).map(toID);
		checks.push((_battle, { holder }) => allowed.includes(toID(holder.baseSpecies.baseSpecies)));
	}
	if ('BaseForm' in fields) {
		const allowed = strings(fields.BaseForm, field('BaseForm')).map(toID);
		checks.push((_battle, { holder }) => allowed.includes(holder.baseSpecies.id));
	}
	if ('MinimumLevel' in fields) {
		const minimum = number(fields.MinimumLevel, field('MinimumLevel'), 1, 100, true);
		checks.push((_battle, { holder }) => holder.level >= minimum);
	}
	if ('MoveIds' in fields) {
		const ids = strings(fields.MoveIds, field('MoveIds')).map(toID);
		checks.push((_battle, context) => ids.includes(move(context)?.id.replace(/^nomelat/, '') ?? ''));
	}
	if ('ExceptMoves' in fields) {
		const ids = strings(fields.ExceptMoves, field('ExceptMoves')).map(toID);
		checks.push((_battle, context) => !ids.includes(move(context)?.id.replace(/^nomelat/, '') ?? ''));
	}
	if ('BlockedFlags' in fields) {
		const blocked = strings(fields.BlockedFlags, field('BlockedFlags')) as (keyof Move['flags'])[];
		checks.push((_battle, context) => !blocked.some(flag => move(context)?.flags[flag]));
	}
	if ('AttackerLacksVolatile' in fields) {
		const conditions = strings(fields.AttackerLacksVolatile, field('AttackerLacksVolatile'));
		checks.push((_battle, { source }) => !!source && !conditions.some(id => source.volatiles[id]));
	}
	if ('EffectAbilities' in fields) {
		const ids = strings(fields.EffectAbilities, field('EffectAbilities'));
		checks.push((_battle, { effect }) => !!effect && ids.includes(effect.id));
	}
	if ('ChangedStats' in fields) {
		const keys = choices(fields.ChangedStats, [...stats.keys()], field('ChangedStats')).map(stat => stats.get(stat)!);
		checks.push((_battle, { boosts }) => !!boosts && keys.some(stat => !!boosts[stat]));
	}
	if ('VolatileFromMove' in fields) {
		const ids = strings(fields.VolatileFromMove, field('VolatileFromMove'));
		checks.push((_battle, context) => ids.includes(move(context)?.volatileStatus ?? ''));
	}
	if ('AtMostHP' in fields) {
		const [n, d] = fraction(fields.AtMostHP, field('AtMostHP'));
		if (n > d) fail(field('AtMostHP'), 'expected a fraction of maximum HP');
		checks.push((_battle, { holder }) => holder.hp * d <= holder.maxhp * n);
	}
	if ('MaximumEffectivePower' in fields) {
		const maximum = number(fields.MaximumEffectivePower, field('MaximumEffectivePower'), 0, 10000);
		checks.push((battle, { value }) => value !== undefined && battle.modify(value, battle.event.modifier) <= maximum);
	}
	condition('HasStatus', (_battle, { holder }) => !!holder.status);
	condition('AtFullHP', (_battle, { holder }) => holder.hp === holder.maxhp);
	condition('AtLeastOneActiveTurn', (_battle, { holder }) => holder.activeTurns > 0);
	condition('ExternalMove', (_battle, { holder, source }) => !!source && holder !== source);
	condition('HolderFainted', (_battle, { holder }) => holder.hp <= 0);
	condition('HolderNotFainted', (_battle, { holder }) => holder.hp > 0);
	condition('AbilityNotSuppressed', (_battle, { holder }) => !holder.ignoringAbility());
	condition('Grounded', (_battle, { holder }) => !!holder.isGrounded());
	condition('SwitchingTarget', (_battle, { target }) => !!target?.newlySwitched);
	condition('TargetIsAlly', (_battle, { holder, source }) => !!source && holder.isAlly(source));
	condition('AgainstDifferentPokemon', (_battle, { holder, source }) => holder !== source);
	condition('TargetHasNotTakenTurn', (_battle, { target }) => !!target && target.activeTurns === 0);
	condition('HasRecoil', (_battle, context) => !!(move(context)?.recoil || move(context)?.hasCrashDamage));
	condition('MovesLast', (battle, { holder }) => battle.getAllActive().every(pokemon => pokemon === holder || !battle.queue.willMove(pokemon)));
	condition('EffectiveWeatherOnly', (_battle, { holder, effect }) => holder.effectiveWeather() === effect?.id);
	condition('NonMoveDamage', (_battle, { effect }) => !!effect && effect.effectType !== 'Move');
	condition('StatusMoveSTAB', (_battle, context) => {
		const used = move(context);
		return !!used && (used.forceSTAB || context.holder.hasType(used.type));
	});
	condition('WithoutDynamax', (_battle, { holder }) => !holder.volatiles.dynamax);
	condition('NotTransformed', (_battle, { holder }) => !holder.transformed);
	condition('NotTerastallized', (_battle, { holder }) => !holder.terastallized);
	condition('Terastallized', (_battle, { holder }) => !!holder.terastallized);
	condition('HasRemainingFoes', (_battle, { holder }) => !!holder.side.foePokemonLeft());
	condition('ExcludeMaxMove', (_battle, context) => !move(context)?.isMax);
	condition('SourceCanBeAffectedByPowder', (_battle, { source }) => !!source?.runStatusImmunity('powder'));
	condition('AffectedByPowderByType', (battle, { holder }) => battle.dex.getImmunity('powder', holder));
	condition('OtherAllyIsTarget', (_battle, { holder, target }) => !!(target && holder !== target && holder.isAlly(target)));
	condition('SourceIsAlly', (_battle, { holder, source }) => !!source && source.isAlly(holder));
	condition('UnprotectedFromSecondary', (_battle, { target }) =>
		!!target && !target.hasAbility('shielddust') && !target.hasItem('covertcloak'));
	condition('CriticalHit', (_battle, { target, effect }) =>
		!!(target && effect?.effectType === 'Move' && target.getMoveHitData(effect as ActiveMove).crit));
	const effectiveness = ({ target, effect }: Context) => target && effect?.effectType === 'Move' ?
		target.getMoveHitData(effect as ActiveMove).typeMod : 0;
	condition('SuperEffective', (_battle, context) => effectiveness(context) > 0);
	condition('Resisted', (_battle, context) => effectiveness(context) < 0);
	if ('ContactAnnouncesProtection' in fields && !('Contact' in fields)) {
		fail(field('ContactAnnouncesProtection'), 'expected a Contact filter');
	}
	const announce = optionalBoolean(fields.ContactAnnouncesProtection, field('ContactAnnouncesProtection'));
	const fromTarget = optionalBoolean(fields.ContactFromTarget, field('ContactFromTarget'));
	condition('Contact', (battle, { target, source, effect }) =>
		!!(source && target && effect?.effectType === 'Move' && battle.checkMoveMakesContact(
			effect as ActiveMove, fromTarget ? target : source, fromTarget ? source : target, announce)));
	return (battle, context) => checks.every(check => check(battle, context));
}

function pokemonContext(battle: Battle, event: typeof pokemonEvents[number], args: any[]): Context {
	const holder = battle.effectState.target as Pokemon;
	switch (event) {
	case 'AfterTakingDamage':
	case 'AfterDealingDamage':
		return { holder, target: args[1], source: args[2], effect: args[3], value: args[0] };
	case 'AfterKnockout':
	case 'AfterAnyFaint':
		return { holder, target: args[1], source: args[2], effect: args[3], count: args[0] };
	case 'OnWeather':
	case 'OnHit':
	case 'AfterMoveSecondary':
		return { holder, target: args[0], source: args[1], effect: args[2] };
	case 'SideConditionStart':
		return { holder, source: args[1], effect: args[2] };
	case 'BeforeMove':
		return { holder, target: args[1], source: args[0], effect: args[2] };
	case 'AfterStatChange':
		return { holder, target: args[1], source: args[2], effect: args[3], boosts: args[0] };
	default:
		return { holder };
	}
}

type Action = (battle: Battle, context: Context) => void;

function strings(value: unknown, path: string): string[] {
	const result = list(value, path).map(entry => {
		if (typeof entry !== 'string' || !entry || !toID(entry)) fail(path, 'expected nonempty IDs');
		return entry;
	});
	if (!result.length || new Set(result).size !== result.length) fail(path, 'expected distinct IDs');
	return result;
}

function action(input: unknown, path: string): Action {
	const fields = object(input, path);
	const field = (key: string) => `${path}.${key}`;
	const keys = (...names: string[]) => object(fields, path, ['Type', 'Recipient', ...names]);
	const recipient = fields.Recipient === undefined ? 'Holder' :
		choice(fields.Recipient, ['Holder', 'Attacker', 'Defender', 'AdjacentFoes', 'AdjacentAllies', 'HolderAndAttacker', 'OtherActive'], field('Recipient'));
	const forPokemon = (apply: (battle: Battle, pokemon: Pokemon, context: Context) => void): Action => (battle, context) => {
		const { holder, source, target } = context;
		const selected = recipient === 'AdjacentFoes' ? holder.adjacentFoes() :
			recipient === 'AdjacentAllies' ? holder.adjacentAllies() :
				recipient === 'OtherActive' ? battle.getAllActive().filter(pokemon => pokemon !== holder && !pokemon.fainted) :
					recipient === 'HolderAndAttacker' ? [source, holder] : [recipient === 'Holder' ? holder : recipient === 'Attacker' ? source : target];
		for (const pokemon of selected) if (pokemon) apply(battle, pokemon, context);
	};
	switch (fields.Type) {
	case 'ChangeStats': {
		keys('Stages', 'PerKnockout', 'BlockBySubstitute', 'Announce', 'AnnounceAsBoost', 'ShowSource', 'AttributionAbility', 'AnnounceAfter');
		const stages = object(fields.Stages, field('Stages'), [...stats.keys()]);
		if (!Object.keys(stages).length) fail(field('Stages'), 'expected a stat change');
		const changes: SparseBoostsTable = {};
		for (const [stat, delta] of Object.entries(stages)) {
			changes[stats.get(stat as Parameters<typeof stats.get>[0])!] = number(delta, field(`Stages.${stat}`), -12, 12, true);
		}
		const perKO = optionalBoolean(fields.PerKnockout, field('PerKnockout'));
		const blocked = optionalBoolean(fields.BlockBySubstitute, field('BlockBySubstitute'));
		const announce = optionalBoolean(fields.Announce, field('Announce'));
		const boostMessage = optionalBoolean(fields.AnnounceAsBoost, field('AnnounceAsBoost'));
		const source = optionalBoolean(fields.ShowSource, field('ShowSource'));
		const announceAfter = optionalBoolean(fields.AnnounceAfter, field('AnnounceAfter'));
		const attribution = fields.AttributionAbility === undefined ? undefined :
			strings([fields.AttributionAbility], field('AttributionAbility'))[0];
		return (battle, context) => {
			const { holder, count } = context;
			let shown = false;
			forPokemon((sim, pokemon) => {
				if (announce && !shown) {
					if (boostMessage) sim.add('-ability', holder, sim.effect.name, 'boost');
					else sim.add('-ability', holder, sim.effect.name);
					shown = true;
				}
				if (blocked && pokemon.volatiles.substitute) {
					sim.add('-immune', pokemon);
					return;
				}
				const boosts = perKO ? Object.fromEntries(Object.entries(changes).map(([stat, delta]) => [stat, delta * (count ?? 1)])) : changes;
				const attributedTo = attribution ? sim.dex.abilities.get(attribution) : null;
				sim.boost(boosts, pokemon, holder, attributedTo, source);
				if (announceAfter) sim.add('-activate', holder, `ability: ${sim.effect.name}`);
			})(battle, context);
		};
	}
	case 'Heal':
	case 'Damage': {
		keys('Fraction', 'HPBasis', 'Silent', 'FromHolder');
		const [n, d] = fraction(fields.Fraction, field('Fraction'));
		if (n > d) fail(field('Fraction'), 'expected a fraction of maximum HP');
		const basis = choice(fields.HPBasis, ['BaseMaxHP', 'MaxHP'], field('HPBasis'));
		const silent = optionalBoolean(fields.Silent, field('Silent'));
		const heal = fields.Type === 'Heal';
		const showHolder = optionalBoolean(fields.FromHolder, field('FromHolder'));
		return forPokemon((battle, pokemon, { holder }) => {
			const hp = (basis === 'BaseMaxHP' ? pokemon.baseMaxhp : pokemon.maxhp) * n / d;
			if (heal) {
				if (silent) pokemon.heal(hp);
				else battle.heal(hp, pokemon, showHolder ? holder : null);
			} else {
				battle.damage(hp, pokemon, holder);
			}
		});
	}
	case 'ApplyStatus': {
		keys('Status', 'FromMove');
		const status = statuses.get(choice(fields.Status, [...statuses.keys()], field('Status')))!;
		const fromMove = optionalBoolean(fields.FromMove, field('FromMove'));
		return forPokemon((_battle, pokemon, { holder, effect }) => { pokemon.trySetStatus(status, holder, fromMove ? effect : undefined); });
	}
	case 'ApplyRandomStatus': {
		keys('Outcomes');
		const outcomes = list(fields.Outcomes, field('Outcomes')).map((entry, index) => {
			const location = field(`Outcomes[${index}]`);
			const outcome = object(entry, location, ['Status', 'Chance']);
			return {
				status: statuses.get(choice(outcome.Status, [...statuses.keys()], `${location}.Status`))!,
				chance: number(outcome.Chance, `${location}.Chance`, 1, 100, true),
			};
		});
		if (!outcomes.length || outcomes.reduce((sum, { chance }) => sum + chance, 0) > 100) {
			fail(field('Outcomes'), 'expected at least one outcome and at most 100% total chance');
		}
		return forPokemon((battle, pokemon, { holder }) => {
			let roll = battle.random(100);
			for (const { status, chance } of outcomes) {
				roll -= chance;
				if (roll >= 0) continue;
				pokemon.trySetStatus(status, holder);
				break;
			}
		});
	}
	case 'ApplyVolatile': {
		keys('Condition', 'FromHolder', 'Announce');
		const [id] = strings([fields.Condition], field('Condition'));
		const fromHolder = optionalBoolean(fields.FromHolder, field('FromHolder'));
		const announce = optionalBoolean(fields.Announce, field('Announce'));
		return (battle, context) => {
			if (announce) battle.add('-ability', context.holder, battle.effect.name);
			forPokemon((_battle, pokemon, { holder }) => { pokemon.addVolatile(id, fromHolder ? holder : undefined); })(battle, context);
		};
	}
	case 'SetWeather':
	case 'SetTerrain': {
		keys('Weather', 'Terrain', 'UnlessSpecies', 'UnlessItem', 'AnnounceIfAlreadyActive', 'AnnounceWeatherSource');
		const terrain = fields.Type === 'SetTerrain';
		const key = terrain ? 'Terrain' : 'Weather';
		const value = choice(fields[key], terrain ? terrains : weathers, field(key));
		const species = fields.UnlessSpecies;
		const item = fields.UnlessItem;
		const announce = optionalBoolean(fields.AnnounceIfAlreadyActive, field('AnnounceIfAlreadyActive'));
		const announceSource = optionalBoolean(fields.AnnounceWeatherSource, field('AnnounceWeatherSource'));
		if ((species === undefined) !== (item === undefined)) fail(path, 'UnlessSpecies and UnlessItem must be specified together');
		if (species !== undefined && (!((typeof species === 'string') && toID(species)) ||
			!((typeof item === 'string') && toID(item)))) fail(path, 'expected species and item IDs');
		return (battle, { holder }) => {
			if (species === holder.species.id && item === holder.item) return;
			const changed = terrain ? battle.field.setTerrain(value) : battle.field.setWeather(value);
			if (changed && announceSource) battle.add('-activate', holder, battle.effect.name, '[source]');
			if (!changed && announce && (terrain ? battle.field.isTerrain(value) : battle.field.isWeather(value))) {
				battle.add('-activate', holder, `ability: ${battle.effect.name}`);
			}
		};
	}
	case 'Announce':
		keys();
		return (battle, { holder }) => battle.add('-ability', holder, battle.effect.name);
	case 'CureStatus':
		keys('AnnounceActivation');
		{
			const announce = optionalBoolean(fields.AnnounceActivation, field('AnnounceActivation'));
			return forPokemon((battle, pokemon, { holder }) => {
			if (!pokemon.status) return;
			if (announce) battle.add('-activate', holder, `ability: ${battle.effect.name}`);
			pokemon.cureStatus();
			});
		}
	case 'RemoveVolatile': {
		keys('Condition', 'AnnounceActivation', 'AnnounceAttractEnd');
		const [id] = strings([fields.Condition], field('Condition'));
		const announce = optionalBoolean(fields.AnnounceActivation, field('AnnounceActivation'));
		const announceEnd = optionalBoolean(fields.AnnounceAttractEnd, field('AnnounceAttractEnd'));
		return forPokemon((battle, pokemon, { holder }) => {
			if (!pokemon.volatiles[id]) return;
			if (announce) battle.add('-activate', holder, `ability: ${battle.effect.name}`);
			pokemon.removeVolatile(id);
			if (announceEnd) battle.add('-end', pokemon, 'move: Attract', `[from] ability: ${battle.effect.name}`);
		});
	}
	case 'AnnounceVolatileImmunity': {
		keys('Condition');
		const [id] = strings([fields.Condition], field('Condition'));
		return (battle, { holder }) => battle.add('-immune', holder, id, `[from] ability: ${battle.effect.name}`);
	}
	case 'ClearWeatherAndTerrain':
		keys();
		return (battle, { holder }) => {
			if (!battle.field.weather && !battle.field.terrain) return;
			battle.add('-ability', holder, battle.effect.name);
			battle.field.clearWeather();
			battle.field.clearTerrain();
		};
	case 'EndHeldItemEffect':
		keys();
		return (battle, { holder }) => { battle.singleEvent('End', holder.getItem(), holder.itemState, holder); };
	case 'ChangeForm': {
		keys('Form', 'From', 'Permanent', 'Announce', 'UpdateMegaAvailability');
		const [form] = strings([fields.Form], field('Form'));
		const from = fields.From === undefined ? undefined : strings(fields.From, field('From')).map(toID);
		const permanent = optionalBoolean(fields.Permanent, field('Permanent'));
		const announce = optionalBoolean(fields.Announce, field('Announce'));
		const updateMega = optionalBoolean(fields.UpdateMegaAvailability, field('UpdateMegaAvailability'));
		return (battle, { holder }) => {
			if (toID(form) === holder.species.id || (from && !from.includes(holder.species.id))) return;
			if (announce) battle.add('-activate', holder, `ability: ${battle.effect.name}`);
			if (permanent) holder.formeChange(form, battle.effect, true);
			else holder.formeChange(form);
			if (updateMega) {
				if (holder.canMegaEvo !== false) holder.canMegaEvo = battle.actions.canMegaEvo(holder);
				holder.formeRegression = true;
			}
		};
	}
	case 'CycleForms': {
		keys('Forms');
		const forms = strings(fields.Forms, field('Forms'));
		const ids = forms.map(toID);
		if (forms.length < 2) fail(field('Forms'), 'expected at least two different forms');
		return (_battle, { holder }) => {
			const current = ids.indexOf(holder.species.id);
			if (current !== -1) holder.formeChange(forms[(current + 1) % forms.length]);
		};
	}
	case 'AddSideHazard': {
		keys('Condition', 'MaximumLayers');
		const [id] = strings([fields.Condition], field('Condition'));
		const layers = number(fields.MaximumLayers, field('MaximumLayers'), 1, 3, true);
		return (battle, { holder, source }) => {
			if (!source) return;
			const side = source.isAlly(holder) ? source.side.foe : source.side;
			if ((side.sideConditions[id]?.layers ?? 0) >= layers) return;
			battle.add('-activate', holder, `ability: ${battle.effect.name}`);
			side.addSideCondition(id, holder);
		};
	}
	case 'ChangeHighestStat': {
		keys('Stages', 'PerKnockout');
		const stages = number(fields.Stages, field('Stages'), 1, 6, true);
		const perKO = optionalBoolean(fields.PerKnockout, field('PerKnockout'));
		return forPokemon((battle, pokemon, { count }) => {
			const stat = pokemon.getBestStat(true, true);
			battle.boost({ [stat]: stages * (perKO ? count ?? 1 : 1) }, pokemon);
		});
	}
	case 'SwapAbilities':
		keys();
		return (battle, { holder, source }) => { if (source) battle.skillSwap(source, holder); };
	case 'ReplaceAttackerAbility':
		keys('ExcludeUnsuppressible');
		{
			const exclude = optionalBoolean(fields.ExcludeUnsuppressible, field('ExcludeUnsuppressible'));
			return (battle, { holder, source }) => {
				if (!source) return;
				const ability = source.getAbility();
				if (ability.id === battle.effect.id || (exclude && ability.flags.cantsuppress)) return;
				source.setAbility(battle.effect.id, holder);
			};
		}
	case 'RestoreBerry': {
		keys('Chance', 'GuaranteedWeather');
		const chance = number(fields.Chance, field('Chance'), 0, 100, true);
		const climate = choices(fields.GuaranteedWeather, weathers, field('GuaranteedWeather'));
		return (battle, { holder }) => {
			if (!battle.field.isWeather(climate) && !battle.randomChance(chance, 100)) return;
			if (!holder.hp || holder.item || !battle.dex.items.get(holder.lastItem).isBerry) return;
			holder.setItem(holder.lastItem);
			holder.lastItem = '' as ID;
			battle.add('-item', holder, holder.getItem(), `[from] ability: ${battle.effect.name}`);
		};
	}
	case 'TransformIntoOpposite':
		keys();
		return (battle, { holder }) => {
			const opposing = holder.side.foe.active;
			const target = opposing[opposing.length - 1 - holder.position];
			if (target) holder.transformInto(target, battle.effect);
		};
	case 'ClearStatStages':
		keys();
		return forPokemon((battle, pokemon, { holder }) => {
			pokemon.clearBoosts();
			battle.add('-clearboost', pokemon, `[from] ability: ${battle.effect.name}`, `[of] ${holder}`);
		});
	case 'RevealStrongestFoeMove': {
		keys('OneHitKnockoutPower', 'CounterPower', 'CounterMoves', 'VariablePower');
		const ohko = number(fields.OneHitKnockoutPower, field('OneHitKnockoutPower'), 1, 10000, true);
		const counter = number(fields.CounterPower, field('CounterPower'), 1, 10000, true);
		const variable = number(fields.VariablePower, field('VariablePower'), 1, 10000, true);
		const counters = strings(fields.CounterMoves, field('CounterMoves'));
		return (battle, { holder }) => {
			let strongest: { move: Move, foe: Pokemon }[] = [];
			let maximum = 1;
			for (const foe of holder.foes()) {
				for (const slot of foe.moveSlots) {
					const move = battle.dex.moves.get(slot.move);
					const power = move.ohko ? ohko : counters.includes(move.id.replace(/^nomelat/, '')) ? counter :
						move.basePower === 1 || (!move.basePower && move.category !== 'Status') ? variable : move.basePower;
					if (power > maximum) {
						maximum = power;
						strongest = [];
					}
					if (power === maximum) strongest.push({ move, foe });
				}
			}
			if (!strongest.length) return;
			const { move, foe } = battle.sample(strongest);
			battle.add('-activate', holder, `ability: ${battle.effect.name}`, move, `[of] ${foe}`);
		};
	}
	case 'CompareFoeDefenses': {
		keys('AttackStages', 'SpecialAttackStages');
		const attack = number(fields.AttackStages, field('AttackStages'), 1, 6, true);
		const special = number(fields.SpecialAttackStages, field('SpecialAttackStages'), 1, 6, true);
		return (battle, { holder }) => {
			const total = (stat: 'def' | 'spd') => holder.foes().reduce((sum, foe) => sum + foe.getStat(stat, false, true), 0);
			const defense = total('def');
			const specialDefense = total('spd');
			if (defense && defense >= specialDefense) battle.boost({ spa: special });
			else if (specialDefense) battle.boost({ atk: attack });
		};
	}
	case 'CopyAllyBoosts': {
		keys('Volatiles');
		const conditions = strings(fields.Volatiles, field('Volatiles'));
		return (battle, { holder }) => {
			const [ally] = holder.allies();
			if (!ally) return;
			holder.setBoost(ally.boosts);
			for (const id of conditions) holder.removeVolatile(id);
			for (const id of conditions) {
				if (!ally.volatiles[id]) continue;
				holder.addVolatile(id);
				if (id === 'gmaxchistrike') holder.volatiles[id].layers = ally.volatiles[id].layers;
				if (id === 'dragoncheer') holder.volatiles[id].hasDragonType = ally.volatiles[id].hasDragonType;
			}
			battle.add('-copyboost', holder, ally, `[from] ability: ${battle.effect.name}`);
		};
	}
	case 'ChooseStatChanges': {
		keys('Stats', 'RaiseStages', 'LowerStages');
		const selected = choices(fields.Stats, [...stats.keys()], field('Stats')).map(stat => stats.get(stat)!);
		const raise = number(fields.RaiseStages, field('RaiseStages'), 1, 6, true);
		const lower = number(fields.LowerStages, field('LowerStages'), 1, 6, true);
		return (battle, { holder }) => {
			const boost: SparseBoostsTable = {};
			const canRaise = selected.filter(stat => holder.boosts[stat] < 6);
			const up = canRaise.length ? battle.sample(canRaise) : undefined;
			const canLower = selected.filter(stat => stat !== up && holder.boosts[stat] > -6);
			if (up) boost[up] = raise;
			if (canLower.length) boost[battle.sample(canLower)] = -lower;
			battle.boost(boost, holder, holder);
		};
	}
	case 'ClearSideConditions': {
		keys('Conditions');
		const conditions = strings(fields.Conditions, field('Conditions'));
		return (battle, { holder }) => {
			let shown = false;
			for (const id of conditions) {
				for (const side of [holder.side, ...holder.side.foeSidesWithConditions()]) {
					if (!side.getSideCondition(id)) continue;
					if (!shown) {
						battle.add('-activate', holder, `ability: ${battle.effect.name}`);
						shown = true;
					}
					side.removeSideCondition(id);
				}
			}
		};
	}
	case 'RevealFoeItems':
		keys();
		return (battle, { holder }) => {
			for (const foe of holder.foes()) {
				if (foe.item) battle.add('-item', foe, foe.getItem().name, `[from] ability: ${battle.effect.name}`, `[of] ${holder}`);
			}
		};
	case 'DetectThreateningMove':
		keys('DetectOneHitKnockout', 'DetectSuperEffective');
		{
			const ohko = optionalBoolean(fields.DetectOneHitKnockout, field('DetectOneHitKnockout'));
			const effective = optionalBoolean(fields.DetectSuperEffective, field('DetectSuperEffective'));
			return (battle, { holder }) => {
				for (const foe of holder.foes()) {
					for (const slot of foe.moveSlots) {
						const move = battle.dex.moves.get(slot.move);
						if (move.category === 'Status') continue;
						const type = move.id.endsWith('hiddenpower') ? foe.hpType : move.type;
						if ((ohko && move.ohko) || (effective && battle.dex.getImmunity(type, holder) && battle.dex.getEffectiveness(type, holder) > 0)) {
							battle.add('-ability', holder, battle.effect.name);
							return;
						}
					}
				}
			};
		}
	default:
		return fail(field('Type'), `unsupported action ${String(fields.Type)}`);
	}
}

function install(ability: AbilityData, name: string, callback: AbilityHook | false, timing: Timing, path: string) {
	const record = ability as unknown as Record<string, unknown>;
	const previous = record[name] as AbilityHook | false | undefined;
	for (const [key, value] of Object.entries(timing)) {
		const order = name + key;
		if (previous !== undefined && (record[order] ?? 0) !== value) fail(path, `conflicting timing for ${name}`);
		record[order] = value;
	}
	if (previous === undefined) {
		record[name] = callback;
	} else {
		if (!callback || !previous) fail(path, `duplicate cancellation for ${name}`);
		record[name] = function (this: Battle, ...args: unknown[]) {
			const result = previous.apply(this, args);
			if (result === false || result === null) return result;
			return callback.apply(this, args) ?? result;
		};
	}
}

function compileRule(ability: CompiledAbility, input: unknown, path: string) {
	const fields = object(input, path);
	const field = (name: string) => `${path}.${name}`;
	const keys = (...names: string[]) => object(fields, path, ['Type', 'Priority', 'Order', 'SubOrder', 'When', ...names]);
	const timing: Timing = {};
	for (const key of ['Priority', 'Order', 'SubOrder'] as const) {
		if (key in fields) timing[key] = number(fields[key], field(key), -1000, 1000, true);
	}
	const allows = filters(fields.When, field('When'));
	const add = (event: string, callback: AbilityHook | false) => install(ability, event, callback, timing, path);
	switch (fields.Type) {
	case 'ModifyValue': {
		keys('Event', 'Operation', 'Amount', 'Ratio', 'OnlyOtherAlly', 'AlternateAt', 'AlternateAmount',
			'MarkPranksterBoost', 'Chance', 'AnnounceActivation');
		const event = choice(fields.Event, modifierEvents, field('Event'));
		const operation = choice(fields.Operation, ['ChainMultiply', 'Add', 'Multiply', 'Set', 'FloorMultiply'], field('Operation'));
		if (('Amount' in fields) === ('Ratio' in fields)) fail(path, 'choose Amount or Ratio');
		const ratio = fields.Ratio === undefined ? undefined : fraction(fields.Ratio, field('Ratio'));
		const parameter = ratio ? ratio[0] / ratio[1] : number(fields.Amount, field('Amount'), -100000, 100000);
		const onlyOther = optionalBoolean(fields.OnlyOtherAlly, field('OnlyOtherAlly'));
		if (('AlternateAt' in fields) !== ('AlternateAmount' in fields)) fail(path, 'expected both alternate values');
		const alternateAt = fields.AlternateAt === undefined ? undefined : number(fields.AlternateAt, field('AlternateAt'), -100000, 100000);
		const alternateAmount = fields.AlternateAmount === undefined ? undefined : number(fields.AlternateAmount, field('AlternateAmount'), -100000, 100000);
		const prankster = optionalBoolean(fields.MarkPranksterBoost, field('MarkPranksterBoost'));
		const announce = optionalBoolean(fields.AnnounceActivation, field('AnnounceActivation'));
		const chance = fields.Chance === undefined ? undefined : number(fields.Chance, field('Chance'), 0, 100, true);
		const defenderFirst = event === 'ModifyAccuracy' || event === 'ModifyAnyAccuracy' || event === 'ModifyOutgoingAccuracy' || event === 'ModifyResidualDamage';
		add(modifierHooks[modifierEvents.indexOf(event)], function (value: number, first?: Pokemon, second?: Pokemon, effect?: Effect) {
			const holder = this.effectState.target as Pokemon;
			const target = defenderFirst ? first : second;
			const source = defenderFirst ? second : first;
			if (typeof value !== 'number' || (onlyOther && source === holder) || !allows(this, { holder, target, source, effect, value })) return;
			if (chance !== undefined && !this.randomChance(chance, 100)) return;
			if (prankster && effect?.effectType === 'Move') (effect as ActiveMove).pranksterBoosted = true;
			if (announce) this.add('-activate', holder, `ability: ${this.effect.name}`);
			if (alternateAmount !== undefined && value === alternateAt) return alternateAmount;
			if (operation === 'ChainMultiply') return this.chainModify(ratio ?? parameter);
			if (operation === 'Add') return value + parameter;
			if (operation === 'Multiply') return value * parameter;
			if (operation === 'FloorMultiply') return Math.floor(value * parameter);
			return parameter;
		});
		break;
	}
	case 'ApplyEffect': {
		keys('Event', 'Chance', 'Effect', 'OncePerBattle');
		const event = choice(fields.Event, pokemonEvents, field('Event'));
		const apply = action(fields.Effect, field('Effect'));
		const chance = fields.Chance === undefined ? undefined : number(fields.Chance, field('Chance'), 0, 100, true);
		const once = optionalBoolean(fields.OncePerBattle, field('OncePerBattle'));
		const used = new WeakSet<Pokemon>();
		add(pokemonHooks[pokemonEvents.indexOf(event)], function (...args: unknown[]) {
			const context = pokemonContext(this, event, args);
			if (once && used.has(context.holder)) return;
			if (!allows(this, context) || (chance !== undefined && !this.randomChance(chance, 100))) return;
			if (once) used.add(context.holder);
			apply(this, context);
		});
		break;
	}
	case 'CureAdjacentAllies': {
		keys('Chance');
		const chance = number(fields.Chance, field('Chance'), 0, 100, true);
		add('onResidual', function (holder: Pokemon) {
			if (!allows(this, { holder })) return;
			for (const ally of holder.adjacentAllies()) {
				if (!ally.status || !this.randomChance(chance, 100)) continue;
				this.add('-activate', holder, `ability: ${this.effect.name}`);
				ally.cureStatus();
			}
		});
		break;
	}
	case 'PeriodicDamageToFoes': {
		keys('Fraction', 'Statuses', 'WithAbility');
		const [n, d] = fraction(fields.Fraction, field('Fraction'));
		if (n > d) fail(field('Fraction'), 'expected a fraction of maximum HP');
		const appliedStatuses = choices(fields.Statuses, [...statuses.keys()], field('Statuses')).map(status => statuses.get(status)!);
		const abilities = fields.WithAbility === undefined ? [] : strings(fields.WithAbility, field('WithAbility'));
		add('onResidual', function (holder: Pokemon) {
			if (!holder.hp || !allows(this, { holder })) return;
			for (const foe of holder.foes()) {
				if (appliedStatuses.includes(foe.status) || foe.hasAbility(abilities)) this.damage(foe.baseMaxhp * n / d, foe, holder);
			}
		});
		break;
	}
	case 'AbsorbMove': {
		keys('Effect', 'ApplyToAllySide', 'SideRequiresAllySource', 'AnnounceActivation', 'Redirect');
		const effect = fields.Effect === undefined ? undefined : object(fields.Effect, field('Effect'));
		const apply = effect && action(effect, field('Effect'));
		const protectSide = optionalBoolean(fields.ApplyToAllySide, field('ApplyToAllySide'));
		const allySource = optionalBoolean(fields.SideRequiresAllySource, field('SideRequiresAllySource'));
		const activate = optionalBoolean(fields.AnnounceActivation, field('AnnounceActivation'));
		const redirect = optionalBoolean(fields.Redirect, field('Redirect'));
		add('onTryHit', function (holder: Pokemon, source: Pokemon, move: ActiveMove) {
			const context = { holder, source, target: holder, effect: move };
			if (!allows(this, context)) return;
			const hp = holder.hp;
			const boosts = { ...holder.boosts };
			apply?.(this, context);
			if (hp === holder.hp && Object.keys(boosts).every(stat => boosts[stat as keyof BoostsTable] === holder.boosts[stat as keyof BoostsTable])) {
				if (activate) this.add('-activate', holder, `ability: ${ability.name}`);
				else this.add('-immune', holder, `[from] ability: ${ability.name}`);
			}
			return null;
		});
		if (protectSide) {
			install(ability, 'onAllyTryHitSide', function (side: Side, source: Pokemon, move: ActiveMove) {
				const holder = this.effectState.target as Pokemon;
				const context = { holder, source, effect: move };
				if ((allySource && !side.active.some(pokemon => pokemon?.isAlly(source))) || !allows(this, context)) return;
				if (apply) apply(this, context);
				else this.add('-immune', holder, `[from] ability: ${ability.name}`);
			}, {}, path);
		}
		if (redirect) {
			install(ability, 'onAnyRedirectTarget', function (target: Pokemon, source: Pokemon, _effect: Effect, move: ActiveMove) {
				const holder = this.effectState.target as Pokemon;
				const targetType = ['randomNormal', 'adjacentFoe'].includes(move.target) ? 'normal' : move.target;
				if (move.flags.pledgecombo || !allows(this, { holder, target, source, effect: move }) ||
					!this.validTarget(holder, source, targetType)) return;
				if (move.smartTarget) move.smartTarget = false;
				if (holder !== target) this.add('-activate', holder, `ability: ${ability.name}`);
				return holder;
			}, {}, path);
		}
		break;
	}
	case 'BlockStatus': {
		keys('Statuses', 'CureExisting', 'BlockYawn');
		const blocked = choices(fields.Statuses, [...statuses.keys()], field('Statuses')).map(status => statuses.get(status)!);
		const cure = optionalBoolean(fields.CureExisting, field('CureExisting'));
		const yawn = optionalBoolean(fields.BlockYawn, field('BlockYawn'));
		add('onSetStatus', function (status: Condition, holder: Pokemon, source: Pokemon, effect?: Effect) {
			if (!blocked.includes(status.id) || !allows(this, { holder, source, effect })) return;
			if (effect?.effectType === 'Move' && effect.status) this.add('-immune', holder, `[from] ability: ${ability.name}`);
			return false;
		});
		if (cure) install(ability, 'onUpdate', function (holder: Pokemon) {
			if (!blocked.includes(holder.status) || !allows(this, { holder })) return;
			this.add('-activate', holder, `ability: ${ability.name}`);
			holder.cureStatus();
		}, {}, path);
		if (yawn) install(ability, 'onTryAddVolatile', function (status: Condition, holder: Pokemon, source: Pokemon, effect: Effect) {
			if (status.id !== 'yawn' || !allows(this, { holder, source, effect })) return;
			this.add('-immune', holder, `[from] ability: ${ability.name}`);
			return null;
		}, {}, path);
		break;
	}
	case 'BlockVolatile': {
		keys('Conditions', 'ApplyToAllies', 'Message');
		const ids = strings(fields.Conditions, field('Conditions'));
		const ally = optionalBoolean(fields.ApplyToAllies, field('ApplyToAllies'));
		const message = choice(fields.Message, ['Silent', 'Immunity', 'AllyBlocked', 'AllyBlockedByMove'], field('Message'));
		add(ally ? 'onAllyTryAddVolatile' : 'onTryAddVolatile',
			function (status: Condition, target: Pokemon, source: Pokemon, effect: Effect) {
				const holder = this.effectState.target as Pokemon;
				if (!ids.includes(status.id) || !allows(this, { holder, target, source, effect })) return;
				if (message === 'Immunity') this.add('-immune', target, `[from] ability: ${this.effect.name}`);
				if (message === 'AllyBlocked' || (message === 'AllyBlockedByMove' && effect?.effectType === 'Move')) {
					this.add('-block', target, `ability: ${this.effect.name}`, `[of] ${holder}`);
				}
				return null;
			});
		break;
	}
	case 'BlockAllyStatus': {
		keys('Statuses', 'BlockIndirect', 'Message', 'ReturnFalse');
		const conditions = choices(fields.Statuses, [...statuses.keys()], field('Statuses')).map(status => statuses.get(status)!);
		const indirect = optionalBoolean(fields.BlockIndirect, field('BlockIndirect'));
		const cancel = optionalBoolean(fields.ReturnFalse, field('ReturnFalse'));
		const message = fields.Message === undefined ? 'Always' :
			choice(fields.Message, ['Always', 'DirectStatusMove', 'DirectOrSynchronize'], field('Message'));
		add('onAllySetStatus', function (status: Condition, target: Pokemon, source: Pokemon, effect: Effect) {
			const holder = this.effectState.target as Pokemon;
			if (!conditions.includes(status.id) || !allows(this, { holder, target, source, effect })) return;
			if (!indirect && (!source || target === source || !effect || effect.id === 'yawn')) return;
			if (message === 'Always' || (message === 'DirectStatusMove' && (effect as Move)?.status) ||
				(message === 'DirectOrSynchronize' && (effect.id === 'synchronize' || (effect.effectType === 'Move' && !effect.secondaries)))) {
				this.add('-block', target, `ability: ${this.effect.name}`, `[of] ${holder}`);
			}
			return cancel ? false : null;
		});
		break;
	}
	case 'BlockStatLoss': {
		keys('Stats', 'IntimidateOnly', 'AnnounceStat', 'SilentForOctolock', 'Reverse', 'ApplyToAllies');
		const protectedStats = fields.Stats === undefined ? [...stats.values()] :
			choices(fields.Stats, [...stats.keys()], field('Stats')).map(stat => stats.get(stat)!);
		const intimidate = optionalBoolean(fields.IntimidateOnly, field('IntimidateOnly'));
		const showStat = optionalBoolean(fields.AnnounceStat, field('AnnounceStat'));
		const octolock = optionalBoolean(fields.SilentForOctolock, field('SilentForOctolock'));
		const reverse = optionalBoolean(fields.Reverse, field('Reverse'));
		const allies = optionalBoolean(fields.ApplyToAllies, field('ApplyToAllies'));
		add(allies ? 'onAllyTryBoost' : 'onTryBoost', function (boost: SparseBoostsTable, target: Pokemon, source: Pokemon, effect: Effect) {
			const holder = this.effectState.target as Pokemon;
			if (!allows(this, { holder, target, source, effect })) return;
			if (intimidate ? effect?.id !== 'intimidate' : target === source) return;
			const removed = protectedStats.filter(stat => (boost[stat] ?? 0) < 0);
			if (!removed.length) return;
			const inverted: SparseBoostsTable = {};
			for (const stat of removed) {
				inverted[stat] = -boost[stat]!;
				delete boost[stat];
			}
			if (reverse) {
				this.boost(inverted, target, target, null, false, true);
			} else if (!(effect as Move)?.secondaries && !(octolock && effect?.id === 'octolock')) {
				if (allies) this.add('-block', target, `ability: ${ability.name}`, `[of] ${holder}`);
				else this.add('-fail', target, 'unboost', ...(showStat ? [removed[0]] : []),
					`[from] ability: ${ability.name}`, `[of] ${target}`);
			}
		});
		break;
	}
	case 'BlockForcedSwitch':
		keys();
		add('onDragOut', function (holder: Pokemon, source: Pokemon, effect: Effect) {
			if (!allows(this, { holder, source, effect })) return;
			this.add('-activate', holder, `ability: ${this.effect.name}`);
			return null;
		});
		break;
	case 'BlockWeatherOrPowder':
		keys('Conditions');
		{
			const conditions = choices(fields.Conditions, ['sandstorm', 'hail', 'powder', 'frz', 'attract'], field('Conditions'));
			add('onImmunity', function (condition: string, holder: Pokemon) {
				if (conditions.some(id => id === condition) && allows(this, { holder })) return false;
			});
		}
		break;
	case 'BlockCriticalHits':
		keys();
		if (fields.When !== undefined) fail(field('When'), 'critical-hit immunity is unconditional');
		add('onCriticalHit', false);
		break;
	case 'ModifyMove': {
		keys('IgnoreAbility', 'IgnoreEvasionStages', 'IgnoreRedirection', 'IgnoreSubstitute', 'IgnoreScreens',
			'RemoveContact', 'FixedMaximumHits', 'BypassProtect', 'IgnoreTypeImmunities', 'SecondaryChanceMultiplier', 'FlinchChance',
			'HitCount');
		const properties = [
			['IgnoreAbility', 'ignoreAbility'], ['IgnoreEvasionStages', 'ignoreEvasion'],
			['IgnoreRedirection', 'tracksTarget'], ['IgnoreSubstitute', 'infiltrates'],
		] as const;
		const values = properties.filter(([key]) => key in fields).map(([key, output]) =>
			[output, optionalBoolean(fields[key], field(key))] as const);
		const removeContact = optionalBoolean(fields.RemoveContact, field('RemoveContact'));
		const maximumHits = optionalBoolean(fields.FixedMaximumHits, field('FixedMaximumHits'));
		const protection = optionalBoolean(fields.BypassProtect, field('BypassProtect'));
		const immunities = fields.IgnoreTypeImmunities === undefined ? [] : choices(fields.IgnoreTypeImmunities, elements, field('IgnoreTypeImmunities'));
		const multiplier = fields.SecondaryChanceMultiplier === undefined ? undefined : number(fields.SecondaryChanceMultiplier, field('SecondaryChanceMultiplier'), 0, 100);
		const flinch = fields.FlinchChance === undefined ? undefined : number(fields.FlinchChance, field('FlinchChance'), 0, 100, true);
		const count = fields.HitCount === undefined ? undefined : number(fields.HitCount, field('HitCount'), 1, 10, true);
		if ('IgnoreScreens' in fields && fields.IgnoreScreens !== fields.IgnoreSubstitute) fail(path, 'the engine bypasses screens and Substitute together');
		add('onModifyMove', function (move: ActiveMove, holder: Pokemon, target: Pokemon | null) {
			if (!allows(this, { holder, target, effect: move })) return;
			for (const [property, value] of values) move[property] = property === 'tracksTarget' ? value && move.target !== 'scripted' : value;
			if (removeContact) delete move.flags.contact;
			if (protection) delete move.flags.protect;
			if (immunities.length && move.ignoreImmunity !== true) {
				move.ignoreImmunity ||= {};
				for (const type of immunities) move.ignoreImmunity[type] = true;
			}
			if (maximumHits) {
				if (Array.isArray(move.multihit) && move.multihit.length) move.multihit = move.multihit[1];
				delete move.multiaccuracy;
			}
			if (count !== undefined) move.multihit = count;
			if (multiplier !== undefined) {
				for (const secondary of move.secondaries ?? []) if (secondary.chance) secondary.chance *= multiplier;
				if (move.self?.chance) move.self.chance *= multiplier;
			}
			if (flinch !== undefined && !move.secondaries?.some(secondary => secondary.volatileStatus === 'flinch')) {
				(move.secondaries ??= []).push({ chance: flinch, volatileStatus: 'flinch' });
			}
		});
		break;
	}
	case 'ReactToStatLoss': {
		keys('Stat', 'Stages');
		const stat = stats.get(choice(fields.Stat, [...stats.keys()], field('Stat')))!;
		const amount = number(fields.Stages, field('Stages'), 1, 6, true);
		add('onAfterEachBoost', function (boosts: SparseBoostsTable, holder: Pokemon, source: Pokemon, effect: Effect) {
			if (!source || holder.isAlly(source) || !Object.values(boosts).some(delta => delta < 0)) return;
			if (allows(this, { holder, source, effect })) this.boost({ [stat]: amount }, holder, holder, null, false, true);
		});
		break;
	}
	case 'PreventDamage': {
		keys('AnnounceSourceAbility', 'Silent', 'ExceptStruggle', 'Effect');
		const announce = optionalBoolean(fields.AnnounceSourceAbility, field('AnnounceSourceAbility'));
		const silent = optionalBoolean(fields.Silent, field('Silent'));
		const struggle = optionalBoolean(fields.ExceptStruggle, field('ExceptStruggle'));
		const apply = fields.Effect === undefined ? undefined : action(fields.Effect, field('Effect'));
		add('onDamage', function (damage: number, holder: Pokemon, source: Pokemon, effect?: Effect) {
			if (struggle && this.activeMove?.id === 'struggle') return;
			if (!allows(this, { holder, source, effect, value: damage })) return;
			if (announce && source && effect?.effectType === 'Ability') this.add('-activate', source, `ability: ${effect.name}`);
			apply?.(this, { holder, target: holder, source, effect, value: damage });
			return silent ? null : false;
		});
		break;
	}
	case 'IgnoreSecondaryEffects':
		keys();
		add('onModifySecondaries', function (secondaries: NonNullable<ActiveMove['secondaries']>, holder: Pokemon, source: Pokemon, move: ActiveMove) {
			if (!allows(this, { holder, source, effect: move })) return;
			return secondaries.filter(effect => !!effect.self);
		});
		break;
	case 'IncreaseOpponentPPUsage': {
		keys('AdditionalPP');
		const amount = number(fields.AdditionalPP, field('AdditionalPP'), 1, 20, true);
		add('onDeductPP', function (holder: Pokemon, source: Pokemon) {
			if (!source || holder.isAlly(source) || !allows(this, { holder, source })) return;
			return amount;
		});
		break;
	}
	case 'SuppressFieldWeather': {
		keys('AnnounceOnSwitchIn');
		const announce = optionalBoolean(fields.AnnounceOnSwitchIn, field('AnnounceOnSwitchIn'));
		if (!ability.suppressWeather) fail(path, 'the ability must set Battle.SuppressWeather');
		const update = (battle: Battle, holder: Pokemon, ending: boolean) => {
			holder.abilityState.ending = ending;
			battle.eachEvent('WeatherChange', battle.effect);
		};
		add('onStart', function (holder: Pokemon) { update(this, holder, false); });
		add('onEnd', function (holder: Pokemon) { update(this, holder, true); });
		add('onSwitchIn', function (holder: Pokemon) {
			if (announce) this.add('-ability', holder, this.effect.name);
			update(this, holder, false);
		});
		break;
	}
	case 'SetWeatherWhileActive': {
		keys('Weather', 'ReplacementWeathers');
		const weather = choice(fields.Weather, weathers, field('Weather'));
		const replacements = choices(fields.ReplacementWeathers, weathers, field('ReplacementWeathers'));
		add('onStart', function () { this.field.setWeather(weather); });
		install(ability, 'onAnySetWeather', function (_target: Pokemon, _source: Pokemon, proposed: Condition) {
			if (this.field.getWeather().id === weather && !replacements.some(id => id === proposed.id)) return false;
		}, {}, path);
		install(ability, 'onEnd', function (holder: Pokemon) {
			if (this.field.weatherState.source !== holder) return;
			const substitute = this.getAllActive().find(pokemon => pokemon !== holder && pokemon.hasAbility(ability.name));
			if (substitute) this.field.weatherState.source = substitute;
			else this.field.clearWeather();
		}, {}, path);
		break;
	}
	case 'BlockFoeBerries': {
		keys('AnnounceAs');
		const labels = fields.AnnounceAs === undefined ? [ability.name] :
			choices(fields.AnnounceAs, ['AsOne', 'Unnerve'], field('AnnounceAs')).map(label => label === 'AsOne' ? 'As One' : 'Unnerve');
		add('onStart', function (holder: Pokemon) {
			if (this.effectState.unnerved || !allows(this, { holder })) return;
			for (const label of labels) this.add('-ability', holder, label);
			this.effectState.unnerved = true;
		});
		install(ability, 'onEnd', function () { this.effectState.unnerved = false; }, {}, path);
		install(ability, 'onFoeTryEatItem', function () { return !this.effectState.unnerved; }, {}, path);
		break;
	}
	case 'CopyFaintedAllyAbility': {
		keys('ExcludeReceiverFlag', 'ExcludeNoAbility');
		const flag = optionalBoolean(fields.ExcludeReceiverFlag, field('ExcludeReceiverFlag'));
		const noAbility = optionalBoolean(fields.ExcludeNoAbility, field('ExcludeNoAbility'));
		add('onAllyFaint', function (ally: Pokemon) {
			const holder = this.effectState.target as Pokemon;
			const inherited = ally.getAbility();
			if (!holder.hp || (flag && inherited.flags.noreceiver) || (noAbility && inherited.id === 'noability') ||
				!allows(this, { holder, target: ally, effect: inherited })) return;
			holder.setAbility(inherited, ally);
		});
		break;
	}
	case 'AdoptMoveType': {
		keys('OncePerSwitch', 'IgnoreIndirectMoves');
		const once = optionalBoolean(fields.OncePerSwitch, field('OncePerSwitch'));
		const indirect = optionalBoolean(fields.IgnoreIndirectMoves, field('IgnoreIndirectMoves'));
		add('onPrepareHit', function (holder: Pokemon, target: Pokemon, move: ActiveMove) {
			if ((once && this.effectState.changedType) || !move.type || move.type === '???' || holder.getTypes().join() === move.type ||
				!allows(this, { holder, target, effect: move })) return;
			if (indirect && (move.hasBounced || move.flags.futuremove || move.sourceEffect === 'snatch' || move.callsMove)) return;
			if (!holder.setType(move.type)) return;
			this.effectState.changedType = true;
			this.add('-start', holder, 'typechange', move.type, `[from] ability: ${this.effect.name}`);
		});
		break;
	}
	case 'BoostAgainstSameGender': {
		keys('SameGenderRatio', 'OppositeGenderRatio');
		const same = fraction(fields.SameGenderRatio, field('SameGenderRatio'));
		const other = fraction(fields.OppositeGenderRatio, field('OppositeGenderRatio'));
		add('onBasePower', function (_power: number, holder: Pokemon, target: Pokemon, move: ActiveMove) {
			if (holder.gender && target?.gender && allows(this, { holder, target, effect: move })) {
				return this.chainModify(holder.gender === target.gender ? same : other);
			}
		});
		break;
	}
	case 'IgnoreBoosts': {
		keys('WhenAttacking', 'WhenDefending');
		const statKeys = [...stats.keys()];
		const offense = choices(fields.WhenAttacking, statKeys, field('WhenAttacking')).map(stat => stats.get(stat)!);
		const defense = choices(fields.WhenDefending, statKeys, field('WhenDefending')).map(stat => stats.get(stat)!);
		add('onAnyModifyBoost', function (boosts: SparseBoostsTable, pokemon: Pokemon) {
			const holder = this.effectState.target as Pokemon;
			if (holder === pokemon || !allows(this, { holder, target: pokemon })) return;
			if (holder === this.activePokemon && pokemon === this.activeTarget) for (const stat of offense) boosts[stat] = 0;
			if (pokemon === this.activePokemon && holder === this.activeTarget) for (const stat of defense) boosts[stat] = 0;
		});
		break;
	}
	case 'BoostWithoutSecondaryEffects': {
		keys('Ratio');
		const ratio = fraction(fields.Ratio, field('Ratio'));
		add('onBasePower', function (_power: number, _holder: Pokemon, _target: Pokemon, move: ActiveMove) {
			if (move.hasSheerForce || move.hasSheerForceBoost) return this.chainModify(ratio);
		});
		install(ability, 'onModifyMove', function (move: ActiveMove, holder: Pokemon, target: Pokemon) {
			if (!move.secondaries || move.hasSheerForceBoost || !allows(this, { holder, target, effect: move })) return;
			delete move.secondaries;
			delete move.self;
			if (move.id === 'clangoroussoulblaze') delete move.selfBoost;
			move.hasSheerForce = true;
		}, {}, path);
		break;
	}
	case 'DamageEqualToReceived': {
		keys('OnlyOnFaint', 'IncludePreviousHits');
		const faint = optionalBoolean(fields.OnlyOnFaint, field('OnlyOnFaint'));
		const multi = optionalBoolean(fields.IncludePreviousHits, field('IncludePreviousHits'));
		add('onDamagingHit', function (damage: number, holder: Pokemon, source: Pokemon, move: ActiveMove) {
			if (!source || (faint && holder.hp) || !allows(this, { holder, source, effect: move })) return;
			const previous = multi && !move.smartTarget ? Number(move.totalDamage) : 0;
			this.damage(holder.getUndynamaxedHP(damage + previous), source, holder);
		});
		break;
	}
	case 'RejectNonSuperEffectiveMoves': {
		keys('ExceptMoves', 'AllowFirstChargeTurn');
		const excluded = strings(fields.ExceptMoves, field('ExceptMoves'));
		const charge = strings(fields.AllowFirstChargeTurn, field('AllowFirstChargeTurn'));
		add('onTryHit', function (holder: Pokemon, source: Pokemon, move: ActiveMove) {
			const id = move.id.replace(/^nomelat/, '');
			if (holder === source || move.category === 'Status' || excluded.includes(id) ||
				(charge.includes(id) && !source.volatiles[id]) || !allows(this, { holder, source, effect: move })) return;
			if (holder.runEffectiveness(move) <= 0 || !holder.runImmunity(move)) {
				if (move.smartTarget) move.smartTarget = false;
				else this.add('-immune', holder, `[from] ability: ${this.effect.name}`);
				return null;
			}
		});
		break;
	}
	case 'ReflectIncomingMoves': {
		keys('ReflectSideMoves', 'RequiredFlag');
		const reflectSide = optionalBoolean(fields.ReflectSideMoves, field('ReflectSideMoves'));
		const flag = choice(fields.RequiredFlag, moveFlags, field('RequiredFlag')) as keyof Move['flags'];
		const reflect = (battle: Battle, holder: Pokemon, source: Pokemon, move: ActiveMove) => {
			const copy = battle.dex.getActiveMove(move.id);
			copy.hasBounced = true;
			copy.pranksterBoosted = false;
			battle.actions.useMove(copy, holder, { target: source });
		};
		add('onTryHit', function (holder: Pokemon, source: Pokemon, move: ActiveMove) {
			if (holder === source || move.hasBounced || !move.flags[flag] || holder.isSemiInvulnerable() ||
				!allows(this, { holder, source, effect: move })) return;
			reflect(this, holder, source, move);
			return null;
		});
		if (reflectSide) install(ability, 'onAllyTryHitSide', function (target: Pokemon, source: Pokemon, move: ActiveMove) {
			const holder = this.effectState.target as Pokemon;
			if (target.isAlly(source) || move.hasBounced || !move.flags[flag] || target.isSemiInvulnerable() ||
				!allows(this, { holder, target, source, effect: move })) return;
			reflect(this, holder, source, move);
			move.hasBounced = true;
			return null;
		}, {}, path);
		break;
	}
	case 'TrapAdjacentFoes': {
		keys('TargetType', 'GroundedOnly', 'ExemptAbility');
		const type = fields.TargetType === undefined ? undefined : choice(fields.TargetType, elements, field('TargetType'));
		const grounded = optionalBoolean(fields.GroundedOnly, field('GroundedOnly'));
		const exempt = fields.ExemptAbility === undefined ? [] : strings([fields.ExemptAbility], field('ExemptAbility'));
		const applies = (battle: Battle, holder: Pokemon, target: Pokemon, estimate: boolean) =>
			target.isAdjacent(holder) && (!type || (estimate && !target.knownType) || target.hasType(type)) &&
			(!grounded || target.isGrounded(estimate && !target.knownType)) &&
			(!exempt.length || !target.hasAbility(exempt)) && allows(battle, { holder, target });
		add('onFoeTrapPokemon', function (target: Pokemon) {
			if (applies(this, this.effectState.target as Pokemon, target, false)) target.tryTrap(true);
		});
		install(ability, 'onFoeMaybeTrapPokemon', function (target: Pokemon, source?: Pokemon) {
			const holder = source ?? this.effectState.target as Pokemon;
			if (holder && applies(this, holder, target, true)) target.maybeTrapped = true;
		}, {}, path);
		break;
	}
	case 'SetFieldTypes': {
		keys('TerrainTypes');
		const terrainTypes = new Map(list(fields.TerrainTypes, field('TerrainTypes')).map((entry, index) => {
			const location = field(`TerrainTypes[${index}]`);
			const pair = object(entry, location, ['Terrain', 'PokemonType']);
			return [choice(pair.Terrain, terrains, `${location}.Terrain`),
				choice(pair.PokemonType, elements, `${location}.PokemonType`)];
		}));
		const update = function (this: Battle, holder: Pokemon) {
			if (!allows(this, { holder })) return;
			const terrainType = terrainTypes.get(this.field.terrain);
			const types = terrainType ? [terrainType] : holder.baseSpecies.types;
			if (holder.getTypes().join() === types.join() || !holder.setType(types)) return;
			if (this.field.terrain || holder.transformed) {
				this.add('-start', holder, 'typechange', types.join('/'), `[from] ability: ${this.effect.name}`);
				if (!this.field.terrain) this.hint('Transform Mimicry changes you to your original un-transformed types.');
			} else {
				this.add('-activate', holder, `ability: ${this.effect.name}`);
				this.add('-end', holder, 'typechange', '[silent]');
			}
		};
		add('onTerrainChange', update);
		install(ability, 'onStart', function (holder: Pokemon) { this.singleEvent('TerrainChange', this.effect, this.effectState, holder); }, {}, path);
		break;
	}
	case 'SetWeatherForm': {
		keys('WeatherForms', 'DefaultForm');
		const weatherForms = new Map(list(fields.WeatherForms, field('WeatherForms')).flatMap((entry, index) => {
			const location = field(`WeatherForms[${index}]`);
			const pair = object(entry, location, ['Weathers', 'Form']);
			const [form] = strings([pair.Form], `${location}.Form`);
			return choices(pair.Weathers, weathers, `${location}.Weathers`).map(weather => [weather, form] as const);
		}));
		const [defaultForm] = strings([fields.DefaultForm], field('DefaultForm'));
		add('onWeatherChange', function (holder: Pokemon) {
			if (!holder.isActive || !allows(this, { holder })) return;
			const form = weatherForms.get(holder.effectiveWeather() as typeof weathers[number]) ?? defaultForm;
			if (toID(form) !== holder.species.id) holder.formeChange(form, this.effect, false, '0', '[msg]');
		});
		install(ability, 'onStart', function (holder: Pokemon) { this.singleEvent('WeatherChange', this.effect, this.effectState, holder); }, {}, path);
		break;
	}
	case 'SetFormByHP': {
		keys('Threshold', 'HighHPForm', 'LowHPForm', 'LowHPUsesTeamForm', 'FromHighHP', 'FromLowHP');
		const [n, d] = fraction(fields.Threshold, field('Threshold'));
		if (n > d) fail(field('Threshold'), 'expected a fraction of maximum HP');
		const [high] = strings([fields.HighHPForm], field('HighHPForm'));
		const teamForm = optionalBoolean(fields.LowHPUsesTeamForm, field('LowHPUsesTeamForm'));
		const low = fields.LowHPForm === undefined ? undefined : strings([fields.LowHPForm], field('LowHPForm'))[0];
		if (teamForm === !!low) fail(path, 'choose a low HP form or the team form');
		const from = (key: string) => fields[key] === undefined ? undefined : strings(fields[key], field(key)).map(toID);
		const highFrom = from('FromHighHP');
		const lowFrom = from('FromLowHP');
		const apply = (battle: Battle, holder: Pokemon) => {
			if (!allows(battle, { holder })) return;
			const up = holder.hp * d > holder.maxhp * n;
			const form = up ? high : low ?? holder.set.species;
			const acceptable = up ? highFrom : lowFrom;
			if (toID(form) === holder.species.id || (acceptable && !acceptable.includes(holder.species.id))) return;
			holder.formeChange(form);
		};
		add('onResidual', function (holder: Pokemon) { if (holder.hp) apply(this, holder); });
		install(ability, 'onStart', function (holder: Pokemon) { apply(this, holder); }, {}, path);
		break;
	}
	case 'ChangeFormOnMove': {
		keys('DefensiveMove', 'DefensiveForm', 'OffensiveForm');
		const [defensiveMove] = strings([fields.DefensiveMove], field('DefensiveMove'));
		const [defensiveForm] = strings([fields.DefensiveForm], field('DefensiveForm'));
		const [offensiveForm] = strings([fields.OffensiveForm], field('OffensiveForm'));
		add('onModifyMove', function (move: ActiveMove, holder: Pokemon, target: Pokemon) {
			if (!allows(this, { holder, target, effect: move })) return;
			const defensive = move.id.replace(/^nomelat/, '') === defensiveMove;
			if (move.category === 'Status' && !defensive) return;
			const form = defensive ? defensiveForm : offensiveForm;
			if (toID(form) !== holder.species.id) holder.formeChange(form);
		});
		break;
	}
	case 'RepeatStatusOnAttacker': {
		keys('Statuses', 'ExcludedSources');
		const conditions = choices(fields.Statuses, [...statuses.keys()], field('Statuses')).map(status => statuses.get(status)!);
		const excluded = strings(fields.ExcludedSources, field('ExcludedSources'));
		add('onAfterSetStatus', function (status: Condition, holder: Pokemon, source: Pokemon, effect?: Effect) {
			if (!source || holder === source || !conditions.includes(status.id) ||
				excluded.includes(effect?.id.replace(/^nomelat/, '') ?? '') || !allows(this, { holder, source, effect })) return;
			this.add('-activate', holder, `ability: ${this.effect.name}`);
			source.trySetStatus(status, holder, { status: status.id, id: this.effect.id } as Effect);
		});
		break;
	}
	case 'ConvertHealingToDamage': {
		keys('Sources');
		const sources = strings(fields.Sources, field('Sources'));
		add('onSourceTryHeal', function (amount: number, target: Pokemon, holder: Pokemon, effect: Effect) {
			if (!effect || !sources.includes(effect.id.replace(/^nomelat/, '')) || !allows(this, { holder, target, effect, value: amount })) return;
			this.damage(amount);
			return 0;
		});
		break;
	}
	case 'BlockMovesGlobally': {
		keys('Moves', 'PreventDamageFromAbilities');
		const moves = strings(fields.Moves, field('Moves'));
		const exempt = fields.PreventDamageFromAbilities === undefined ? [] : strings(fields.PreventDamageFromAbilities, field('PreventDamageFromAbilities'));
		add('onAnyTryMove', function (target: Pokemon, source: Pokemon, move: ActiveMove) {
			const holder = this.effectState.target as Pokemon;
			if (!moves.includes(move.id.replace(/^nomelat/, '')) || !allows(this, { holder, target, source, effect: move })) return;
			this.attrLastMove('[still]');
			this.add('cant', holder, `ability: ${this.effect.name}`, move, `[of] ${target}`);
			return false;
		});
		if (exempt.length) install(ability, 'onAnyDamage', function (_damage: number, _target: Pokemon, _source: Pokemon, effect?: Effect) {
			if (effect?.effectType === 'Ability' && exempt.includes(effect.id)) return false;
		}, {}, path);
		break;
	}
	case 'AlternateActionTurns': {
		keys();
		const id = toID(ability.name);
		ability.condition = {};
		add('onBeforeMove', function (holder: Pokemon) {
			if (!allows(this, { holder })) return;
			if (holder.removeVolatile(id)) {
				this.add('cant', holder, `ability: ${this.effect.name}`);
				return false;
			}
			holder.addVolatile(id);
		});
		install(ability, 'onStart', function (holder: Pokemon) {
			holder.removeVolatile(id);
			if (holder.activeTurns && (holder.moveThisTurnResult !== undefined || !this.queue.willMove(holder))) holder.addVolatile(id);
		}, {}, path);
		break;
	}
	case 'BoostAfterItemLoss': {
		keys('Stat', 'Ratio');
		choice(fields.Stat, ['Speed'], field('Stat'));
		const id = toID(ability.name);
		const ratio = fraction(fields.Ratio, field('Ratio'));
		ability.condition = {
			onModifySpe(_speed, holder) {
				if (!holder.item && !holder.ignoringAbility()) return this.chainModify(ratio);
			},
		};
		add('onAfterUseItem', function (_item: Item, holder: Pokemon) {
			if (holder === this.effectState.target && allows(this, { holder })) holder.addVolatile(id);
		});
		add('onTakeItem', function (_item: Item, holder: Pokemon) {
			if (allows(this, { holder })) holder.addVolatile(id);
		});
		add('onEnd', function (holder: Pokemon) { holder.removeVolatile(id); });
		break;
	}
	case 'ReflectStatLoss': {
		keys();
		add('onTryBoost', function (boost: SparseBoostsTable, holder: Pokemon, source: Pokemon, effect: Effect) {
			if (!source || holder === source || !boost || effect.id === this.effect.id || !allows(this, { holder, source, effect })) return;
			for (const [stat, delta] of Object.entries(boost) as [keyof SparseBoostsTable, number][]) {
				if (delta >= 0 || holder.boosts[stat] === -6) continue;
				delete boost[stat];
				if (!source.hp) continue;
				this.add('-ability', holder, this.effect.name);
				this.boost({ [stat]: delta }, source, holder, null, true);
			}
		});
		break;
	}
	case 'PartialProtectBypass':
		keys();
		add('onHitProtect', function (holder: Pokemon, target: Pokemon, move: ActiveMove) {
			if (!allows(this, { holder, target, effect: move })) return;
			target.getMoveHitData(move).bypassProtect = this.effect;
			return false;
		});
		break;
	case 'SetAbilityStateFlag': {
		keys('Flag');
		const flag = choice(fields.Flag, ['gluttony'], field('Flag'));
		const set = function (this: Battle, holder: Pokemon) {
			if (allows(this, { holder })) holder.abilityState[flag] = true;
		};
		add('onStart', set);
		add('onDamage', function (_amount: number, holder: Pokemon) { set.call(this, holder); });
		break;
	}
	case 'ApplyWeatherDamageRule': {
		keys('Weather');
		const weather = choice(fields.Weather, ['sunnyday'], field('Weather'));
		add('onWeatherModifyDamage', function (damage: number, holder: Pokemon, target: Pokemon, move: ActiveMove) {
			if (!allows(this, { holder, target, effect: move })) return;
			const effect = (this.dex.conditions.get(weather) as Condition & {
				onWeatherModifyDamage?: AbilityHook;
			}).onWeatherModifyDamage;
			effect?.call(this, damage, holder, target, move);
			return damage;
		});
		break;
	}
	case 'AbsorbAndBoostType': {
		keys('MoveType', 'Ratio', 'BoostPriority', 'NeverMissIncoming');
		const type = choice(fields.MoveType, elements, field('MoveType'));
		const ratio = fraction(fields.Ratio, field('Ratio'));
		const priority = number(fields.BoostPriority, field('BoostPriority'), -1000, 1000, true);
		const hit = optionalBoolean(fields.NeverMissIncoming, field('NeverMissIncoming'));
		const id = toID(ability.name);
		const boost = function (this: Battle, _value: number, holder: Pokemon, _target: Pokemon, move: ActiveMove) {
			if (move.type === type && holder.hasAbility(id)) return this.chainModify(ratio);
		};
		ability.condition = {
			noCopy: true,
			onStart(holder) { this.add('-start', holder, `ability: ${ability.name}`); },
			onEnd(holder) { this.add('-end', holder, `ability: ${ability.name}`, '[silent]'); },
			onModifyAtkPriority: priority, onModifyAtk: boost,
			onModifySpAPriority: priority, onModifySpA: boost,
		};
		add('onTryHit', function (holder: Pokemon, source: Pokemon, move: ActiveMove) {
			if (holder === source || move.type !== type || !allows(this, { holder, source, effect: move })) return;
			if (hit) move.accuracy = true;
			if (!holder.addVolatile(id)) this.add('-immune', holder, `[from] ability: ${this.effect.name}`);
			return null;
		});
		add('onEnd', function (holder: Pokemon) { holder.removeVolatile(id); });
		break;
	}
	case 'TemporaryStatPenalty': {
		keys('Turns', 'AttackRatio', 'SpeedRatio', 'AttackPriority');
		const turns = number(fields.Turns, field('Turns'), 1, 100, true);
		const attack = fraction(fields.AttackRatio, field('AttackRatio'));
		const speed = fraction(fields.SpeedRatio, field('SpeedRatio'));
		const priority = number(fields.AttackPriority, field('AttackPriority'), -1000, 1000, true);
		add('onResidual', function (holder: Pokemon) {
			if (!holder.activeTurns || !this.effectState.counter) return;
			if (--this.effectState.counter === 0) {
				this.add('-end', holder, this.effect.name);
				delete this.effectState.counter;
			}
		});
		install(ability, 'onStart', function (holder: Pokemon) {
			if (!allows(this, { holder })) return;
			this.add('-start', holder, `ability: ${this.effect.name}`);
			this.effectState.counter = turns;
		}, {}, path);
		install(ability, 'onEnd', function (holder: Pokemon) {
			if (!holder.beingCalledBack && this.effectState.counter) this.add('-end', holder, this.effect.name, '[silent]');
		}, {}, path);
		install(ability, 'onModifyAtk', function () { if (this.effectState.counter) return this.chainModify(attack); }, { Priority: priority }, path);
		install(ability, 'onModifySpe', function () { if (this.effectState.counter) return this.chainModify(speed); }, {}, path);
		break;
	}
	case 'BoostOnCrossingHPThreshold': {
		keys('Threshold', 'DelayedItems', 'Effect', 'AllowSmartTargetMultiDamage');
		const [n, d] = fraction(fields.Threshold, field('Threshold'));
		const items = strings(fields.DelayedItems, field('DelayedItems'));
		const apply = action(fields.Effect, field('Effect'));
		const smart = optionalBoolean(fields.AllowSmartTargetMultiDamage, field('AllowSmartTargetMultiDamage'));
		add('onAfterMoveSecondary', function (holder: Pokemon, source: Pokemon, move: ActiveMove) {
			this.effectState.checkedThreshold = true;
			if (!source || holder === source || !holder.hp || !move.totalDamage || !allows(this, { holder, source, effect: move })) return;
			const last = holder.getLastAttackedBy();
			if (!last) return;
			const damage = move.multihit && (smart || !move.smartTarget) ? move.totalDamage : last.damage;
			if (holder.hp * d <= holder.maxhp * n && (holder.hp + damage) * d > holder.maxhp * n) {
				apply(this, { holder, source, target: holder, effect: move, value: damage });
			}
		});
		install(ability, 'onDamage', function (_damage: number, _target: Pokemon, _source: Pokemon, effect: Effect) {
			this.effectState.checkedThreshold = !(effect.effectType === 'Move' && !effect.multihit && !this.suppressingSecondaries());
		}, {}, path);
		install(ability, 'onTryEatItem', function (item: Item) {
			return !items.includes(item.id) || this.effectState.checkedThreshold;
		}, {}, path);
		break;
	}
	case 'AdoptIncomingMoveType': {
		keys('ExcludedMoveTypes', 'RetargetMoves');
		const excluded = choices(fields.ExcludedMoveTypes, elements, field('ExcludedMoveTypes'));
		const retarget = strings(fields.RetargetMoves, field('RetargetMoves'));
		add('onAfterMoveSecondary', function (holder: Pokemon, source: Pokemon, move: ActiveMove) {
			if (!holder.hp || !holder.isActive || move.effectType !== 'Move' || move.category === 'Status' ||
				excluded.includes(move.type) || holder.hasType(move.type) || !allows(this, { holder, source, effect: move })) return;
			if (!holder.setType(move.type)) return false;
			this.add('-start', holder, 'typechange', move.type, `[from] ability: ${this.effect.name}`);
			if (holder.side.active.length === 2 && holder.position === 1) {
				const queued = this.queue.willMove(holder);
				if (queued && retarget.includes(queued.move.id.replace(/^nomelat/, ''))) queued.targetLoc = -1;
			}
		});
		break;
	}
	case 'ReplayConsumedBerry': {
		keys('DelayTurns', 'ExcludedMoves');
		const delay = number(fields.DelayTurns, field('DelayTurns'), 1, 20, true);
		const excluded = strings(fields.ExcludedMoves, field('ExcludedMoves'));
		add('onResidual', function (holder: Pokemon) {
			const item: Item | undefined = this.effectState.berry;
			if (!item || !holder.hp || --this.effectState.counter > 0) return;
			this.add('-activate', holder, `ability: ${this.effect.name}`);
			this.add('-enditem', holder, item.name, '[eat]');
			if (this.singleEvent('Eat', item, null, holder, null, null)) this.runEvent('EatItem', holder, null, null, item);
			if (item.onEat) holder.ateBerry = true;
			delete this.effectState.berry;
			delete this.effectState.counter;
		});
		install(ability, 'onEatItem', function (item: Item, holder: Pokemon, source: Pokemon, effect: Effect) {
			if (item.isBerry && !excluded.includes(effect?.id.replace(/^nomelat/, '') ?? '') && allows(this, { holder, source, effect })) {
				this.effectState.berry = item;
				this.effectState.counter = this.queue.peek() ? delay : delay - 1;
			}
		}, {}, path);
		break;
	}
	case 'DoubleSingleHitMoves': {
		keys('ExcludedFlags', 'FirstHitFlinchOnlyFor');
		const flags = strings(fields.ExcludedFlags, field('ExcludedFlags')) as (keyof ActiveMove['flags'])[];
		const only = strings(fields.FirstHitFlinchOnlyFor, field('FirstHitFlinchOnlyFor'));
		add('onPrepareHit', function (holder: Pokemon, target: Pokemon, move: ActiveMove) {
			if (move.category === 'Status' || move.multihit || move.spreadHit || move.isZ || move.isMax ||
				flags.some(flag => move.flags[flag]) || !allows(this, { holder, target, effect: move })) return;
			move.multihit = 2;
			move.multihitType = 'parentalbond';
		});
		install(ability, 'onSourceModifySecondaries', function (secondaries: NonNullable<ActiveMove['secondaries']>,
			_target: Pokemon, _source: Pokemon, move: ActiveMove) {
			if (move.multihitType === 'parentalbond' && only.includes(move.id.replace(/^nomelat/, '')) && move.hit < 2) {
				return secondaries.filter(effect => effect.volatileStatus === 'flinch');
			}
		}, {}, path);
		break;
	}
	case 'LockFirstMove': {
		keys();
		const skip = (move: ActiveMove) => move.isZOrMaxPowered || move.id === 'struggle';
		add('onBeforeMove', function (holder: Pokemon, target: Pokemon, move: ActiveMove) {
			if (skip(move) || !allows(this, { holder, target, effect: move })) return;
			if (holder.abilityState.choiceLock && holder.abilityState.choiceLock !== move.id) {
				this.addMove('move', holder, move.name);
				this.attrLastMove('[still]');
				this.add('-fail', holder);
				return false;
			}
		});
		add('onModifyMove', function (move: ActiveMove, holder: Pokemon) {
			if (!holder.abilityState.choiceLock && !skip(move)) holder.abilityState.choiceLock = move.id;
		});
		add('onDisableMove', function (holder: Pokemon) {
			const lock = holder.abilityState.choiceLock;
			if (!lock || holder.volatiles.dynamax) return;
			for (const slot of holder.moveSlots) if (slot.id !== lock) holder.disableMove(slot.id, false, this.effectState.sourceEffect);
		});
		const clear = function (holder: Pokemon) { holder.abilityState.choiceLock = ''; };
		add('onStart', clear);
		add('onEnd', clear);
		break;
	}
	case 'CopyFoeAbility': {
		keys('BlockedItem', 'ExcludeCopyFlag');
		const [item] = strings([fields.BlockedItem], field('BlockedItem'));
		const flag = choice(fields.ExcludeCopyFlag, flags, field('ExcludeCopyFlag')) as keyof Ability['flags'];
		add('onStart', function (holder: Pokemon) {
			this.effectState.seek = !holder.adjacentFoes().some(foe => foe.ability === 'noability');
			if (holder.hasItem(item)) {
				this.add('-block', holder, `item: ${this.dex.items.get(item).name}`);
				this.effectState.seek = false;
			}
			if (this.effectState.seek) this.singleEvent('Update', this.effect, this.effectState, holder);
		});
		install(ability, 'onUpdate', function (holder: Pokemon) {
			if (!this.effectState.seek || !allows(this, { holder })) return;
			const targets = holder.adjacentFoes().filter(foe => !foe.getAbility().flags[flag] && foe.ability !== 'noability');
			if (!targets.length) return;
			const foe = this.sample(targets);
			holder.setAbility(foe.getAbility(), foe);
		}, {}, path);
		break;
	}
	case 'BoostForFaintedAllies': {
		keys('PowerByCount', 'Denominator');
		const denominator = number(fields.Denominator, field('Denominator'), 1, 100000, true);
		const amounts = list(fields.PowerByCount, field('PowerByCount'))
			.map((value, index) => number(value, field(`PowerByCount[${index}]`), 1, 100000, true));
		if (amounts.length < 2) fail(field('PowerByCount'), 'expected at least one increase');
		add('onBasePower', function () {
			const count = this.effectState.fallen;
			if (count) return this.chainModify([amounts[count], denominator]);
		});
		install(ability, 'onStart', function (holder: Pokemon) {
			if (!holder.side.totalFainted || !allows(this, { holder })) return;
			const count = Math.min(holder.side.totalFainted, amounts.length - 1);
			this.effectState.fallen = count;
			this.add('-activate', holder, `ability: ${this.effect.name}`);
			this.add('-start', holder, `fallen${count}`, '[silent]');
		}, {}, path);
		install(ability, 'onEnd', function (holder: Pokemon) {
			if (!holder.beingCalledBack && this.effectState.fallen) this.add('-end', holder, `fallen${this.effectState.fallen}`, '[silent]');
		}, {}, path);
		break;
	}
	case 'StealHeldItem': {
		keys('From', 'ExceptMoves', 'RequiredFlag');
		const from = choice(fields.From, ['Attacker', 'HitTargets'], field('From'));
		const excluded = fields.ExceptMoves === undefined ? [] : strings(fields.ExceptMoves, field('ExceptMoves'));
		const flag = fields.RequiredFlag === undefined ? undefined :
			choice(fields.RequiredFlag, moveFlags, field('RequiredFlag')) as keyof Move['flags'];
		const steal = (battle: Battle, holder: Pokemon, target: Pokemon, announceLoss: boolean) => {
			if (holder === target) return false;
			const item = target.takeItem(holder);
			if (!item) return false;
			if (!holder.setItem(item)) {
				target.item = item.id;
				return false;
			}
			if (announceLoss) battle.add('-enditem', target, item, '[silent]', `[from] ability: ${ability.name}`, `[of] ${target}`);
			battle.add('-item', holder, item, `[from] ability: ${ability.name}`, `[of] ${target}`);
			return true;
		};
		if (from === 'Attacker') {
			add('onAfterMoveSecondary', function (holder: Pokemon, source: Pokemon, move: ActiveMove) {
				if (!source || !move || holder.item || holder.switchFlag || holder.forceSwitchFlag || source.switchFlag === true ||
					(flag && !move.flags[flag]) || !allows(this, { holder, source, effect: move })) return;
				steal(this, holder, source, true);
			});
		} else {
			add('onAfterMoveSecondarySelf', function (holder: Pokemon, target: Pokemon, move: ActiveMove) {
				if (!move || holder.switchFlag === true || !move.hitTargets || holder.item || holder.volatiles.gem ||
					move.category === 'Status' || excluded.includes(move.id.replace(/^nomelat/, '')) ||
					!allows(this, { holder, target, effect: move })) return;
				this.speedSort(move.hitTargets);
				move.hitTargets.some(pokemon => steal(this, holder, pokemon, false));
			});
		}
		break;
	}
	case 'GiveItemToAllyAfterUse':
		keys();
		add('onAllyAfterUseItem', function (_used: Item, target: Pokemon) {
			const holder = this.effectState.target as Pokemon;
			if (target.switchFlag || !allows(this, { holder, target })) return;
			const item = holder.takeItem();
			if (!item) return;
			if (!this.singleEvent('TakeItem', item, holder.itemState, target, holder, this.effect, item) || !target.setItem(item)) {
				holder.item = item.id;
				return;
			}
			this.add('-activate', holder, `ability: ${this.effect.name}`, item, `[of] ${target}`);
		});
		break;
	case 'RecoverAdjacentUsedItem':
		keys();
		add('onResidual', function (holder: Pokemon) {
			if (holder.item || !allows(this, { holder })) return;
			const candidates = this.getAllActive().filter(target => target.lastItem && target.usedItemThisTurn && holder.isAdjacent(target));
			if (!candidates.length) return;
			const target = this.sample(candidates);
			const item = target.lastItem;
			target.lastItem = '' as ID;
			this.add('-item', holder, this.dex.items.get(item), `[from] ability: ${this.effect.name}`);
			holder.setItem(item);
		});
		break;
	case 'ApplyVolatileAfterInflictingStatus': {
		keys('Condition', 'Statuses');
		const [condition] = strings([fields.Condition], field('Condition'));
		const ailments = choices(fields.Statuses, [...statuses.keys()], field('Statuses')).map(status => statuses.get(status)!);
		add('onAnyAfterSetStatus', function (status: Condition, target: Pokemon, source: Pokemon, effect: Effect) {
			const holder = this.effectState.target as Pokemon;
			if (holder === source && target !== source && effect?.effectType === 'Move' && ailments.includes(status.id) &&
				allows(this, { holder, target, source, effect })) target.addVolatile(condition);
		});
		break;
	}
	case 'CureAllyStatusOnEntry': {
		keys('Statuses');
		const ailments = choices(fields.Statuses, [...statuses.keys()], field('Statuses')).map(status => statuses.get(status)!);
		const cure = function (this: Battle, holder: Pokemon, pokemon: Pokemon) {
			if (!ailments.includes(pokemon.status) || !allows(this, { holder, target: pokemon })) return;
			this.add('-activate', holder, `ability: ${this.effect.name}`);
			pokemon.cureStatus();
		};
		add('onStart', function (holder: Pokemon) { for (const ally of holder.alliesAndSelf()) cure.call(this, holder, ally); });
		install(ability, 'onUpdate', function (holder: Pokemon) { cure.call(this, holder, holder); }, {}, path);
		install(ability, 'onAnySwitchIn', function () {
			const holder = this.effectState.target as Pokemon;
			for (const ally of holder.alliesAndSelf()) cure.call(this, holder, ally);
		}, {}, path);
		break;
	}
	case 'CureStatusOnSwitchOut':
		keys();
		add('onCheckShow', function (holder: Pokemon) {
			if (holder.side.active.length === 1 || holder.showCure !== undefined) return;
			const cured: Pokemon[] = [];
			let possibleOthers = 0;
			for (const pokemon of holder.side.active) {
				if (!pokemon?.status || pokemon.showCure) continue;
				const abilities = pokemon.species.abilities;
				if (!Object.values(abilities).includes(ability.name) || (!abilities['1'] && !abilities.H)) continue;
				if (pokemon !== holder && !this.queue.willSwitch(pokemon)) continue;
				if (pokemon.hasAbility(this.effect.id)) cured.push(pokemon);
				else possibleOthers++;
			}
			if (!cured.length || !possibleOthers) {
				for (const pokemon of cured) pokemon.showCure = true;
			} else {
				this.add('-message', `(${cured.length} of ${holder.side.name}'s pokemon ${cured.length === 1 ? 'was' : 'were'} cured by ${ability.name}.)`);
				for (const pokemon of cured) pokemon.showCure = false;
			}
		});
		add('onSwitchOut', function (holder: Pokemon) {
			if (!holder.status || !allows(this, { holder })) return;
			holder.showCure ??= true;
			if (holder.showCure) this.add('-curestatus', holder, holder.status, `[from] ability: ${ability.name}`, '[silent]');
			holder.clearStatus();
			if (!holder.showCure) holder.showCure = undefined;
		});
		break;
	case 'ChangeFormOnRecall': {
		keys('Form');
		const [form] = strings([fields.Form], field('Form'));
		add('onSwitchOut', function (holder: Pokemon) {
			if (holder.species.id === toID(form) || !allows(this, { holder })) return;
			holder.formeChange(form, this.effect, true);
			holder.heroMessageDisplayed = false;
		});
		add('onSwitchIn', function (holder: Pokemon) {
			if (holder.species.id !== toID(form) || holder.heroMessageDisplayed || !allows(this, { holder })) return;
			this.add('-activate', holder, `ability: ${this.effect.name}`);
			holder.heroMessageDisplayed = true;
		});
		break;
	}
	case 'SetConditionalHighestStatBoost': {
		keys('Weather', 'Terrain', 'StatRatio', 'SpeedRatio', 'Item');
		const weather = fields.Weather === undefined ? undefined : choice(fields.Weather, weathers, field('Weather'));
		const terrain = fields.Terrain === undefined ? undefined : choice(fields.Terrain, terrains, field('Terrain'));
		if (!!weather === !!terrain) fail(path, 'choose exactly one field trigger');
		const [item] = strings([fields.Item], field('Item'));
		const regular = fraction(fields.StatRatio, field('StatRatio'));
		const speed = fraction(fields.SpeedRatio, field('SpeedRatio'));
		const id = toID(ability.name);
		const updateEvent = weather ? 'WeatherChange' : 'TerrainChange';
		const boost = (stat: keyof StatsTable) => function (this: Battle, _value: number, holder: Pokemon) {
			if (this.effectState.bestStat === stat && !holder.ignoringAbility()) return this.chainModify(stat === 'spe' ? speed : regular);
		};
		ability.condition = {
			noCopy: true,
			onStart(holder, _source, effect) {
				const fromItem = effect?.effectType === 'Item' && effect.id === item;
				if (fromItem) this.effectState.fromBooster = true;
				this.add('-activate', holder, `ability: ${ability.name}`, ...(fromItem ? ['[fromitem]'] : []));
				this.effectState.bestStat = holder.getBestStat(false, true);
				this.add('-start', holder, id + this.effectState.bestStat);
			},
			onModifyAtkPriority: 5, onModifyAtk: boost('atk'),
			onModifySpAPriority: 5, onModifySpA: boost('spa'),
			onModifyDefPriority: 6, onModifyDef: boost('def'),
			onModifySpDPriority: 6, onModifySpD: boost('spd'),
			onModifySpe: boost('spe'),
			onEnd(holder) { this.add('-end', holder, ability.name); },
		};
		add('on' + updateEvent, function (holder: Pokemon) {
			const active = weather ? this.field.isWeather(weather) : this.field.isTerrain(terrain!);
			if (active && allows(this, { holder })) holder.addVolatile(id);
			else if (!holder.volatiles[id]?.fromBooster) holder.removeVolatile(id);
		});
		install(ability, 'onStart', function (holder: Pokemon) { this.singleEvent(updateEvent, this.effect, this.effectState, holder); }, {}, path);
		install(ability, 'onEnd', function (holder: Pokemon) {
			delete holder.volatiles[id];
			this.add('-end', holder, ability.name, '[silent]');
		}, {}, path);
		break;
	}
	case 'ProtectFormFromFirstHit': {
		keys('Forms', 'WeatherToRestore', 'DamageAfterBreaking');
		const forms = new Map(list(fields.Forms, field('Forms')).map((entry, index) => {
			const location = field(`Forms[${index}]`);
			const item = object(entry, location, ['Intact', 'Broken']);
			const [intact] = strings([item.Intact], `${location}.Intact`);
			const [broken] = strings([item.Broken], `${location}.Broken`);
			return [toID(intact), broken];
		}));
		if (!forms.size) fail(field('Forms'), 'expected at least one form');
		const weather = fields.WeatherToRestore === undefined ? [] : choices(fields.WeatherToRestore, weathers, field('WeatherToRestore'));
		const damageAfter = fields.DamageAfterBreaking === undefined ? undefined : fraction(fields.DamageAfterBreaking, field('DamageAfterBreaking'));
		const protectedFrom = (battle: Battle, holder: Pokemon, move: ActiveMove, respectSubstitute: boolean) => {
			if (!holder || move.category === 'Status' || !forms.has(holder.species.id) || !allows(battle, { holder, effect: move })) return false;
			if (!respectSubstitute) return true;
			const bypass = move.flags.bypasssub || (move.infiltrates && battle.gen >= 6);
			return (!holder.volatiles.substitute || !!bypass) && holder.runImmunity(move);
		};
		add('onDamage', function (_damage: number, holder: Pokemon, _source: Pokemon, effect: Effect) {
			if (effect?.effectType !== 'Move' || !protectedFrom(this, holder, effect as ActiveMove, false)) return;
			this.add('-activate', holder, `ability: ${this.effect.name}`);
			this.effectState.busted = true;
			return 0;
		});
		install(ability, 'onCriticalHit', function (holder: Pokemon, _source: Pokemon, move: ActiveMove) {
			if (protectedFrom(this, holder, move, true)) return false;
		}, {}, path);
		install(ability, 'onEffectiveness', function (_value: number, holder: Pokemon, _type: string, move: ActiveMove) {
			if (protectedFrom(this, holder, move, true)) return 0;
		}, {}, path);
		install(ability, 'onUpdate', function (holder: Pokemon) {
			const form = forms.get(holder.species.id);
			if (!form || !this.effectState.busted) return;
			holder.formeChange(form, this.effect, true);
			if (damageAfter) this.damage(holder.baseMaxhp * damageAfter[0] / damageAfter[1], holder, holder, this.dex.species.get(form));
		}, {}, path);
		if (weather.length) {
			const restore = function (this: Battle, holder: Pokemon) {
				if (!this.field.isWeather(weather)) return;
				const intact = [...forms].find(([, broken]) => toID(broken) === holder.species.id)?.[0];
				if (!intact) return;
				this.add('-activate', holder, `ability: ${this.effect.name}`);
				this.effectState.busted = false;
				holder.formeChange(intact, this.effect, true);
			};
			install(ability, 'onStart', restore, {}, path);
			install(ability, 'onWeatherChange', function (holder: Pokemon, _source: Pokemon, effect?: Effect) {
				if (holder.hp && !(effect as Ability | undefined)?.suppressWeather) restore.call(this, holder);
			}, {}, path);
		}
		break;
	}
	case 'EnterAllyOnSwitchIn': {
		keys('HolderSpecies', 'AllySpecies', 'HolderCondition', 'AllyCondition');
		const [holderSpecies] = strings([fields.HolderSpecies], field('HolderSpecies'));
		const [allySpecies] = strings([fields.AllySpecies], field('AllySpecies'));
		const [holderCondition] = strings([fields.HolderCondition], field('HolderCondition'));
		const [allyCondition] = strings([fields.AllyCondition], field('AllyCondition'));
		const update = function (this: Battle, holder: Pokemon) {
			if (this.gameType !== 'doubles' || this.queue.peek()?.choice === 'runSwitch' || !allows(this, { holder })) return;
			const [ally] = holder.allies();
			if (holder.switchFlag || ally?.switchFlag) return;
			if (!ally || toID(holder.baseSpecies.baseSpecies) !== holderSpecies || toID(ally.baseSpecies.baseSpecies) !== allySpecies) {
				holder.removeVolatile(holderCondition);
				return;
			}
			if (!holder.getVolatile(holderCondition)) {
				if (ally.getVolatile(allyCondition)) return;
				this.queue.cancelAction(holder);
				this.add('-activate', holder, `ability: ${this.effect.name}`, `[of] ${ally}`);
				holder.addVolatile(holderCondition);
				ally.addVolatile(allyCondition, holder);
			} else if (ally.fainted) {
				holder.removeVolatile(holderCondition);
			}
		};
		add('onAnySwitchIn', function () { update.call(this, this.effectState.target as Pokemon); });
		install(ability, 'onStart', update, {}, path);
		install(ability, 'onUpdate', update, {}, path);
		break;
	}
	case 'DisguiseAsLastTeammate': {
		keys('ExcludedTeraSpecies');
		const excluded = strings(fields.ExcludedTeraSpecies, field('ExcludedTeraSpecies'));
		add('onBeforeSwitchIn', function (holder: Pokemon) {
			holder.illusion = null;
			if (!allows(this, { holder })) return;
			const target = holder.side.pokemon.slice(holder.position + 1).findLast(pokemon => !pokemon.fainted);
			if (target && !(holder.terastallized && excluded.includes(toID(target.species.baseSpecies)))) holder.illusion = target;
		});
		add('onDamagingHit', function (_damage: number, holder: Pokemon, source: Pokemon, move: ActiveMove) {
			if (holder.illusion) this.singleEvent('End', this.effect, holder.abilityState, holder, source, move);
		});
		add('onEnd', function (holder: Pokemon) {
			if (!holder.illusion || holder.beingCalledBack) return;
			holder.illusion = null;
			this.add('replace', holder, holder.getUpdatedDetails());
			this.add('-end', holder, ability.name);
			if (this.ruleTable.has('illusionlevelmod' as ID)) this.hint("Illusion Level Mod is active, so this Pokémon's true level was hidden.", true);
		});
		add('onFaint', function (holder: Pokemon) { holder.illusion = null; });
		break;
	}
	case 'StoreAndLaunchOnHit': {
		keys('Move', 'BaseForm', 'HighHPForm', 'LowHPForm', 'Threshold', 'DamageFraction', 'HighHPEffect', 'LowHPEffect');
		const [moveId] = strings([fields.Move], field('Move'));
		const [base] = strings([fields.BaseForm], field('BaseForm'));
		const [high] = strings([fields.HighHPForm], field('HighHPForm'));
		const [low] = strings([fields.LowHPForm], field('LowHPForm'));
		const [n, d] = fraction(fields.Threshold, field('Threshold'));
		const [damageN, damageD] = fraction(fields.DamageFraction, field('DamageFraction'));
		const highEffect = action(fields.HighHPEffect, field('HighHPEffect'));
		const lowEffect = action(fields.LowHPEffect, field('LowHPEffect'));
		add('onDamagingHit', function (_damage: number, holder: Pokemon, source: Pokemon, move: ActiveMove) {
			if (!source.hp || !source.isActive || holder.isSemiInvulnerable() || !allows(this, { holder, source, effect: move })) return;
			if (holder.species.id !== toID(high) && holder.species.id !== toID(low)) return;
			this.damage(source.baseMaxhp * damageN / damageD, source, holder);
			(holder.species.id === toID(high) ? highEffect : lowEffect)(this, { holder, target: holder, source, effect: move });
			holder.formeChange(base, move);
		});
		install(ability, 'onSourceTryPrimaryHit', function (target: Pokemon, holder: Pokemon, move: ActiveMove) {
			if (move?.id.replace(/^nomelat/, '') === moveId && holder.hasAbility(ability.name) && holder.species.id === toID(base) &&
				allows(this, { holder, target, effect: move })) holder.formeChange(holder.hp * d <= holder.maxhp * n ? low : high, move);
		}, {}, path);
		break;
	}
	case 'CopyFoeStatGains': {
		keys('ExcludedEffects', 'SwitchInPriority');
		const excluded = strings(fields.ExcludedEffects, field('ExcludedEffects'));
		const priority = number(fields.SwitchInPriority, field('SwitchInPriority'), -1000, 1000, true);
		add('onResidual', function () {
			if (!this.effectState.boosts) return;
			this.boost(this.effectState.boosts, this.effectState.target);
			delete this.effectState.boosts;
		});
		const flush = function (this: Battle) {
			if (!this.effectState.boosts) return;
			this.boost(this.effectState.boosts, this.effectState.target);
			delete this.effectState.boosts;
		};
		install(ability, 'onAnySwitchIn', flush, { Priority: priority }, path);
		for (const event of ['onAnyAfterMega', 'onAnyAfterTerastallization', 'onAnyAfterMove']) install(ability, event, flush, {}, path);
		install(ability, 'onEnd', function () { delete this.effectState.boosts; }, {}, path);
		install(ability, 'onFoeAfterBoost', function (boosts: SparseBoostsTable, target: Pokemon, source: Pokemon, effect: Effect) {
			const holder = this.effectState.target as Pokemon;
			if (excluded.includes(effect?.id ?? '') || !allows(this, { holder, target, source, effect })) return;
			const accumulated = (this.effectState.boosts ??= {}) as SparseBoostsTable;
			for (const [stat, delta] of Object.entries(boosts) as [keyof SparseBoostsTable, number][]) {
				if (delta > 0) accumulated[stat] = (accumulated[stat] ?? 0) + delta;
			}
		}, {}, path);
		break;
	}
	case 'IncreaseBerryEffects': {
		keys('EffectRatio', 'ResistanceRatio', 'ResistanceBerries', 'AnnounceForItems', 'ResistancePriority', 'EatPriority');
		const main = fraction(fields.EffectRatio, field('EffectRatio'));
		const resist = fraction(fields.ResistanceRatio, field('ResistanceRatio'));
		const berries = strings(fields.ResistanceBerries, field('ResistanceBerries'));
		const items = strings(fields.AnnounceForItems, field('AnnounceForItems'));
		const resistancePriority = number(fields.ResistancePriority, field('ResistancePriority'), -1000, 1000, true);
		const eatPriority = number(fields.EatPriority, field('EatPriority'), -1000, 1000, true);
		const announce = function (this: Battle, holder: Pokemon) { this.add('-activate', holder, `ability: ${this.effect.name}`); };
		add('onTryHeal', function (_amount: number, holder: Pokemon, source: Pokemon, effect?: Effect) {
			if (!effect || !allows(this, { holder, source, effect })) return;
			if (items.includes(effect.id)) announce.call(this, holder);
			if (effect.effectType === 'Item' && effect.isBerry) return this.chainModify(main);
		});
		install(ability, 'onChangeBoost', function (boosts: SparseBoostsTable, _holder: Pokemon, _source: Pokemon, effect: Effect) {
			if (effect?.effectType !== 'Item' || !effect.isBerry) return;
			for (const stat of Object.keys(boosts) as (keyof SparseBoostsTable)[]) boosts[stat]! *= main[0] / main[1];
		}, {}, path);
		install(ability, 'onSourceModifyDamage', function (_amount: number, _source: Pokemon, holder: Pokemon) {
			if (!holder.abilityState.berryWeaken) return;
			holder.abilityState.berryWeaken = false;
			return this.chainModify(resist);
		}, { Priority: resistancePriority }, path);
		install(ability, 'onTryEatItem', function (_item: Item, holder: Pokemon) { announce.call(this, holder); }, { Priority: eatPriority }, path);
		install(ability, 'onEatItem', function (item: Item, holder: Pokemon) { holder.abilityState.berryWeaken = berries.includes(item.id); }, {}, path);
		break;
	}
	case 'SetVolatileFormByHP': {
		keys('Threshold', 'Forms');
		const [n, d] = fraction(fields.Threshold, field('Threshold'));
		const forms = new Map(list(fields.Forms, field('Forms')).map((entry, index) => {
			const location = field(`Forms[${index}]`);
			const group = object(entry, location, ['Original', 'Alternate']);
			const [original] = strings([group.Original], `${location}.Original`);
			const [alternate] = strings([group.Alternate], `${location}.Alternate`);
			return [toID(original), alternate];
		}));
		if (!forms.size) fail(field('Forms'), 'expected at least one form');
		const id = toID(ability.name);
		const originals = new Map([...forms].map(([original, alternate]) => [toID(alternate), original]));
		ability.condition = {
			onStart(holder) {
				const form = forms.get(holder.species.id);
				if (form) holder.formeChange(form);
			},
			onEnd(holder) {
				const form = originals.get(holder.species.id);
				if (form) holder.formeChange(form);
			},
		};
		add('onResidual', function (holder: Pokemon) {
			if (!allows(this, { holder })) return;
			if (holder.hp * d <= holder.maxhp * n && forms.has(holder.species.id)) holder.addVolatile(id);
			else if (holder.hp * d > holder.maxhp * n && originals.has(holder.species.id)) {
				holder.addVolatile(id);
				holder.removeVolatile(id);
			}
		});
		install(ability, 'onEnd', function (holder: Pokemon) {
			if (!holder.volatiles[id] || !holder.hp) return;
			holder.transformed = false;
			delete holder.volatiles[id];
			const form = originals.get(holder.species.id);
			if (form) holder.formeChange(form, this.effect, false, '0', '[silent]');
		}, {}, path);
		break;
	}
	case 'SuppressOtherAbilities': {
		keys('ProtectionItem', 'PreservedVolatile', 'EndIllusion', 'ClearVolatile', 'EndAbilities', 'ResetBerryThreshold');
		if (toID(ability.name) !== 'neutralizinggas') fail(path, 'ability suppression is tied to Neutralizing Gas by the engine');
		const [item] = strings([fields.ProtectionItem], field('ProtectionItem'));
		const [preserved] = strings([fields.PreservedVolatile], field('PreservedVolatile'));
		const [clear] = strings([fields.ClearVolatile], field('ClearVolatile'));
		const [berry] = strings([fields.ResetBerryThreshold], field('ResetBerryThreshold'));
		const endAbilities = strings(fields.EndAbilities, field('EndAbilities'));
		const illusion = optionalBoolean(fields.EndIllusion, field('EndIllusion'));
		add('onSwitchIn', function (holder: Pokemon) {
			this.add('-ability', holder, this.effect.name);
			holder.abilityState.ending = false;
			for (const target of this.getAllActive()) {
				if (target.hasItem(item)) {
					this.add('-block', target, `item: ${this.dex.items.get(item).name}`);
					continue;
				}
				if (target.volatiles[preserved]) continue;
				if (illusion && target.illusion) this.singleEvent('End', this.dex.abilities.get('illusion'), target.abilityState, target, holder, this.effect.id);
				if (target.volatiles[clear]) {
					delete target.volatiles[clear];
					this.add('-end', target, this.dex.abilities.get(clear).name, '[silent]');
				}
				const targetAbility = target.getAbility();
				if (endAbilities.includes(targetAbility.id)) this.singleEvent('End', targetAbility, target.abilityState, target, holder, this.effect.id);
			}
		});
		install(ability, 'onEnd', function (holder: Pokemon) {
			if (holder.transformed || this.getAllActive().some(pokemon => pokemon !== holder && pokemon.hasAbility(this.effect.id))) return;
			this.add('-end', holder, `ability: ${this.effect.name}`);
			if (holder.abilityState.ending) return;
			holder.abilityState.ending = true;
			const active = this.getAllActive();
			this.speedSort(active);
			for (const pokemon of active) {
				if (pokemon === holder || pokemon.getAbility().flags.cantsuppress || pokemon.hasItem(item)) continue;
				this.singleEvent('Start', pokemon.getAbility(), pokemon.abilityState, pokemon);
				if (pokemon.ability === berry) pokemon.abilityState.gluttony = false;
			}
		}, {}, path);
		break;
	}
	case 'ProtectHeldItem': {
		keys('ExcludedItems', 'BlockedSelfTargetMoves');
		const items = strings(fields.ExcludedItems, field('ExcludedItems'));
		const moves = strings(fields.BlockedSelfTargetMoves, field('BlockedSelfTargetMoves'));
		add('onTakeItem', function (_item: Item, holder: Pokemon, source: Pokemon) {
			if (!this.activeMove || !holder.hp || items.includes(holder.item) ||
				!allows(this, { holder, source, effect: this.activeMove })) return;
			if (source && source !== holder || moves.includes(this.activeMove.id.replace(/^nomelat/, ''))) {
				this.add('-activate', holder, `ability: ${this.effect.name}`);
				return false;
			}
		});
		break;
	}
	case 'StatAura': {
		keys('Stat', 'Ratio', 'RevalidatePreviousHolder');
		const stat = choice(fields.Stat, ['Attack', 'Defense', 'SpecialAttack', 'SpecialDefense'], field('Stat'));
		const hooks = { Attack: 'onAnyModifyAtk', Defense: 'onAnyModifyDef', SpecialAttack: 'onAnyModifySpA', SpecialDefense: 'onAnyModifySpD' };
		const storage = { Attack: 'ruinedAtk', Defense: 'ruinedDef', SpecialAttack: 'ruinedSpA', SpecialDefense: 'ruinedSpD' } as const;
		const ratio = fraction(fields.Ratio, field('Ratio'));
		const revalidate = optionalBoolean(fields.RevalidatePreviousHolder, field('RevalidatePreviousHolder'));
		add(hooks[stat], function (_value: number, target: Pokemon, source: Pokemon, move: ActiveMove) {
			const holder = this.effectState.target as Pokemon;
			if (target.hasAbility(ability.name) || !allows(this, { holder, target, source, effect: move })) return;
			const key = storage[stat];
			if (!move[key] || (revalidate && !move[key]?.hasAbility(ability.name))) move[key] = holder;
			if (move[key] === holder) return this.chainModify(ratio);
		});
		install(ability, 'onStart', function (holder: Pokemon) {
			if (!this.suppressingAbility(holder)) this.add('-ability', holder, this.effect.name);
		}, {}, path);
		break;
	}
	case 'BoostTypeAura': {
		keys('MoveType', 'Ratio', 'ReversedRatio');
		const type = choice(fields.MoveType, elements, field('MoveType'));
		const ratio = fraction(fields.Ratio, field('Ratio'));
		const reversed = fraction(fields.ReversedRatio, field('ReversedRatio'));
		add('onAnyBasePower', function (_value: number, source: Pokemon, target: Pokemon, move: ActiveMove) {
			const holder = this.effectState.target as Pokemon;
			if (source === target || move.category === 'Status' || move.type !== type || !allows(this, { holder, target, source, effect: move })) return;
			if (!move.auraBooster?.hasAbility(ability.name)) move.auraBooster = holder;
			if (move.auraBooster === holder) return this.chainModify(move.hasAuraBreak ? reversed : ratio);
		});
		install(ability, 'onStart', function (holder: Pokemon) {
			if (!this.suppressingAbility(holder)) this.add('-ability', holder, this.effect.name);
		}, {}, path);
		break;
	}
	case 'ReverseTypeAuras':
		keys();
		add('onAnyTryPrimaryHit', function (target: Pokemon, source: Pokemon, move: ActiveMove) {
			const holder = this.effectState.target as Pokemon;
			if (target !== source && move.category !== 'Status' && allows(this, { holder, target, source, effect: move })) move.hasAuraBreak = true;
		});
		break;
	case 'ForceSwitchBelowHP': {
		keys('Threshold');
		const [n, d] = fraction(fields.Threshold, field('Threshold'));
		if (n > d) fail(field('Threshold'), 'expected a fraction of maximum HP');
		add('onEmergencyExit', function (original: number, holder: Pokemon) {
			if (!holder.hp || holder.hp * d > holder.maxhp * n || original * d <= holder.maxhp * n) return;
			if (!allows(this, { holder }) || !this.canSwitch(holder.side) || holder.forceSwitchFlag || holder.switchFlag) return;
			for (const side of this.sides) for (const active of side.active) if (active) active.switchFlag = false;
			holder.switchFlag = true;
			this.add('-activate', holder, `ability: ${this.effect.name}`);
		});
		break;
	}
	case 'BlockPriorityMoves': {
		keys('AbovePriority', 'AllowedAllTargetExceptions');
		const minimum = number(fields.AbovePriority, field('AbovePriority'), 0, 20);
		const ids = strings(fields.AllowedAllTargetExceptions, field('AllowedAllTargetExceptions'));
		add('onFoeTryMove', function (target: Pokemon, source: Pokemon, move: ActiveMove) {
			const holder = this.effectState.target as Pokemon;
			if (move.target === 'foeSide' || (move.target === 'all' && !ids.includes(move.id.replace(/^nomelat/, '')))) return;
			if (!(source.isAlly(holder) || move.target === 'all') || move.priority <= minimum ||
				!allows(this, { holder, target, source, effect: move })) return;
			this.attrLastMove('[still]');
			this.add('cant', holder, `ability: ${this.effect.name}`, move, `[of] ${target}`);
			return false;
		});
		break;
	}
	case 'AlwaysHits': {
		keys('BypassInvulnerability');
		const bypass = optionalBoolean(fields.BypassInvulnerability, field('BypassInvulnerability'));
		const applies = (battle: Battle, target: Pokemon, source: Pokemon, move: ActiveMove) => {
			const holder = battle.effectState.target as Pokemon;
			return move && (source === holder || target === holder) && allows(battle, { holder, target, source, effect: move });
		};
		install(ability, 'onAnyAccuracy', function (accuracy: number | true, target: Pokemon, source: Pokemon, move: ActiveMove) {
			return applies(this, target, source, move) ? true : accuracy;
		}, {}, path);
		if (bypass) add('onAnyInvulnerability', function (target: Pokemon, source: Pokemon, move: ActiveMove) {
			if (applies(this, target, source, move)) return 0;
		});
		break;
	}
	case 'ChangeMoveType': {
		keys('Into', 'ExcludedMoves', 'AllowMaxMoves', 'ExcludeZAttacks', 'ExcludeTerastallizedTeraBlast', 'PowerBonus');
		const type = choice(fields.Into, elements, field('Into'));
		const excluded = fields.ExcludedMoves === undefined ? [] : list(fields.ExcludedMoves, field('ExcludedMoves')).map(value => {
			if (typeof value !== 'string' || !toID(value)) return fail(field('ExcludedMoves'), 'expected a move ID');
			return toID(value);
		});
		const max = optionalBoolean(fields.AllowMaxMoves, field('AllowMaxMoves'));
		const z = optionalBoolean(fields.ExcludeZAttacks, field('ExcludeZAttacks'));
		const tera = optionalBoolean(fields.ExcludeTerastallizedTeraBlast, field('ExcludeTerastallizedTeraBlast'));
		const power = fields.PowerBonus === undefined ? undefined : object(fields.PowerBonus, field('PowerBonus'), ['Ratio', 'Priority']);
		add('onModifyType', function (move: ActiveMove, holder: Pokemon) {
			const id = move.id.replace(/^nomelat/, '');
			if (excluded.includes(id) && !(max && this.activeMove?.isMax)) return;
			if (z && move.isZ && move.category !== 'Status') return;
			if (tera && id === 'terablast' && holder.terastallized) return;
			if (!allows(this, { holder, effect: move })) return;
			move.type = type;
			if (power) move.typeChangerBoosted = this.effect;
		});
		if (power) {
			const ratio = fraction(power.Ratio, field('PowerBonus.Ratio'));
			const priority = number(power.Priority, field('PowerBonus.Priority'), -1000, 1000, true);
			install(ability, 'onBasePower', function (_power: number, _holder: Pokemon, _target: Pokemon, move: ActiveMove) {
				if (move.typeChangerBoosted === this.effect) return this.chainModify(ratio);
			}, { Priority: priority }, path);
		}
		break;
	}
	case 'ChangeStatStages': {
		keys('Multiplier', 'ExcludeZPower');
		const multiplier = number(fields.Multiplier, field('Multiplier'), -6, 6, true);
		const skip = optionalBoolean(fields.ExcludeZPower, field('ExcludeZPower'));
		add('onChangeBoost', function (boosts: SparseBoostsTable, holder: Pokemon, source: Pokemon, effect: Effect) {
			if ((skip && effect?.id === 'zpower') || !allows(this, { holder, source, effect })) return;
			for (const stat of Object.keys(boosts) as (keyof SparseBoostsTable)[]) boosts[stat]! *= multiplier;
		});
		break;
	}
	case 'PreventKnockout': {
		keys('BlockOneHitKnockoutMoves', 'SurviveAtHP');
		const block = optionalBoolean(fields.BlockOneHitKnockoutMoves, field('BlockOneHitKnockoutMoves'));
		const survive = number(fields.SurviveAtHP, field('SurviveAtHP'), 1, 65535, true);
		add('onDamage', function (damage: number, holder: Pokemon, source: Pokemon, effect?: Effect) {
			if (damage < holder.hp || !allows(this, { holder, source, effect, value: damage })) return;
			this.add('-ability', holder, this.effect.name);
			return Math.max(0, holder.hp - survive);
		});
		if (block) install(ability, 'onTryHit', function (holder: Pokemon, _source: Pokemon, move: ActiveMove) {
			if (!move.ohko) return;
			this.add('-immune', holder, `[from] ability: ${this.effect.name}`);
			return null;
		}, {}, path);
		break;
	}
	case 'EngineRule':
		keys('Rule');
		{
			const expected = engineRules.get(toID(ability.name));
			if (!expected || fields.Rule !== expected || fields.When !== undefined || Object.keys(timing).length) {
				fail(path, 'the configured rule is tied to a specific ability by the engine');
			}
		}
		break;
	case 'NoBattleEffect':
		keys();
		if (fields.When !== undefined || Object.keys(timing).length) fail(path, 'an inert ability has no timing or filters');
		break;
	default:
		fail(field('Type'), `unsupported ability rule ${String(fields.Type)}`);
	}
}

/** Compiles an editable asset. The parent entry is only used for identity and to clear inherited hooks. */
export function translateNomelatAbility(assetId: string, input: unknown, registry: EngineDex): AbilityData {
	const id = toID(assetId);
	if (!id || id === 'constructor') fail('Ability', 'invalid ability ID');
	const parent = registry.dex.data.Abilities[id];
	const battle = object(object(input, 'Ability', ['Battle']).Battle, 'Battle', ['Flags', 'SuppressWeather', 'SwitchInPriority', 'Rules']);
	const rules = list(battle.Rules, 'Battle.Rules');
	if (!rules.length) fail('Battle.Rules', 'expected at least one rule');
	if (engineRules.has(id) && !rules.some(rule => object(rule, 'Battle.Rules entry').Type === 'EngineRule')) {
		fail('Battle.Rules', `${assetId} requires the ${engineRules.get(id)} rule of the engine`);
	}
	const ability: CompiledAbility = {
		name: parent?.name ?? assetId.replaceAll('_', ' '),
		num: parent?.num ?? 0,
		rating: parent?.rating ?? 0,
		gen: parent?.gen ?? 0,
		isNonstandard: parent?.isNonstandard ?? null,
		flags: Object.fromEntries((battle.Flags === undefined ? [] : choices(battle.Flags, flags, 'Battle.Flags')).map(flag => [flag, 1])),
		suppressWeather: optionalBoolean(battle.SuppressWeather, 'Battle.SuppressWeather'),
	};
	const data = ability as unknown as Fields;
	for (const key of Object.keys(parent ?? {})) {
		if (/^on[A-Z]/.test(key) || key === 'condition') data[key] = undefined;
	}
	for (const [index, rule] of rules.entries()) compileRule(ability, rule, `Battle.Rules[${index}]`);
	if (battle.SwitchInPriority !== undefined) {
		const priority = number(battle.SwitchInPriority, 'Battle.SwitchInPriority', -1000, 1000, true);
		if (ability.onSwitchInPriority !== undefined && ability.onSwitchInPriority !== priority) {
			fail('Battle.SwitchInPriority', 'conflicts with a switch-in rule');
		}
		ability.onSwitchInPriority = priority;
	}
	return ability;
}

type Assets = Record<string, unknown>;
interface CatalogSnapshot {
	readonly registry: EngineDex;
	moveId(assetId: string): string;
	abilityId(assetId: string): string;
}

function normalize(input: Assets, path: string) {
	const entries = new Map<string, [string, unknown]>();
	for (const [name, payload] of Object.entries(object(input, path))) {
		const id = toID(name);
		if (!id || id === 'constructor' || entries.has(id)) fail(path, `invalid or duplicate ID ${name}`);
		entries.set(id, [name, payload]);
	}
	return entries;
}

/** Moves and abilities are published together so an active battle retains one Dex for both. */
export class NomelatBattleCatalog {
	readonly #makeRegistry: RegistryFactory;
	#snapshot: CatalogSnapshot;

	constructor(makeRegistry: RegistryFactory) {
		this.#makeRegistry = makeRegistry;
		this.#snapshot = this.publish({}, {});
	}

	replace({ moves = {}, abilities = {} }: { moves?: Assets, abilities?: Assets }) {
		this.#snapshot = this.publish(moves, abilities);
	}

	snapshot() {
		return this.#snapshot;
	}

	private publish(moves: Assets, abilities: Assets): CatalogSnapshot {
		const registry = this.#makeRegistry();
		if (registry === this.#snapshot?.registry) throw new Error('Expected a fresh EngineDex');
		const translatedMoves = new Map<string, ReturnType<typeof translateNomelatMove>>();
		const translatedAbilities = new Map<string, AbilityData>();
		for (const [id, [name, input]] of normalize(abilities, 'Abilities')) {
			try {
				translatedAbilities.set(id, translateNomelatAbility(name, input, registry));
			} catch (error) {
				throw new Error(`${name}: ${(error as Error).message}`, { cause: error });
			}
		}
		for (const [id, [name, input]] of normalize(moves, 'Moves')) {
			const key = `nomelat${id}`;
			if (registry.dex.moves.get(key).exists) fail(name, 'movement ID already exists');
			translatedMoves.set(key, translateNomelatMove(`Nomelat ${name}`, input));
		}
		const abilitiesToRegister: Abilities = Object.fromEntries(translatedAbilities);
		registry.register({ moves: Object.fromEntries(translatedMoves), abilities: abilitiesToRegister });
		return Object.freeze({
			registry,
			moveId(assetId: string) {
				const id = `nomelat${toID(assetId)}`;
				if (!translatedMoves.has(id)) fail('Moves', `unpublished asset ${assetId}`);
				return id;
			},
			abilityId(assetId: string) {
				const id = toID(assetId);
				if (!translatedAbilities.has(id)) fail('Abilities', `unpublished asset ${assetId}`);
				return id;
			},
		});
	}
}

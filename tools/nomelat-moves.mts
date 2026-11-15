import type { Battle } from '../sim/battle.ts';
import type { MoveAction } from '../sim/battle-queue.ts';
import type { ActiveMove, HitEffect, MoveData, SecondaryEffect } from '../sim/dex-moves.ts';
import type { EngineDex } from '../sim/engine-dex.ts';
import type { Pokemon } from '../sim/pokemon.ts';

type Fields = Record<string, unknown>;
type MoveStat = NonNullable<MoveData['overrideOffensiveStat']>;
type NativeHitEffect = HitEffect & Pick<MoveData, 'heal'>;
type EffectAction = (battle: Battle, recipient: Pokemon, user: Pokemon, move: ActiveMove) => boolean;
type Requirement = (battle: Battle, user: Pokemon, target: Pokemon | null, move: ActiveMove) => boolean;
type PokemonCheck = (pokemon: Pokemon, battle: Battle, user: Pokemon, target: Pokemon | null, move: ActiveMove) => boolean;

const toID = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '');
const statuses = new Map([
	['Burn', 'brn'], ['Freeze', 'frz'], ['Paralysis', 'par'], ['Poison', 'psn'],
	['BadPoison', 'tox'], ['Sleep', 'slp'],
]);
const stats = new Map<string, MoveStat>([
	['Attack', 'atk'], ['Defense', 'def'], ['SpecialAttack', 'spa'],
	['SpecialDefense', 'spd'], ['Speed', 'spe'],
]);
const stages = new Map<string, keyof SparseBoostsTable>([...stats, ['Accuracy', 'accuracy'], ['Evasion', 'evasion']]);
const targets = [
	'adjacentAlly', 'adjacentAllyOrSelf', 'adjacentFoe', 'all', 'allAdjacent', 'allAdjacentFoes',
	'allies', 'allySide', 'allyTeam', 'any', 'foeSide', 'normal', 'randomNormal', 'scripted', 'self',
] as const;
const switches = new Map<string, MoveData['selfSwitch']>([
	['Standard', true], ['CopyVolatile', 'copyvolatile'], ['ShedTail', 'shedtail'],
]);
const booleanFields = {
	RollAccuracyPerHit: 'multiaccuracy',
	UsableAsleep: 'sleepUsable',
	TracksTarget: 'tracksTarget',
	StealsStatStages: 'stealsBoosts',
	NoPPBoosts: 'noPPBoosts',
	ForceSwitch: 'forceSwitch',
	IgnoreAbility: 'ignoreAbility',
	IgnoreEvasionStages: 'ignoreEvasion',
	IgnoreDefenseStages: 'ignoreDefensive',
	ThawsTarget: 'thawsTarget',
	SmartTarget: 'smartTarget',
	BreaksProtect: 'breaksProtect',
	SheerForceBoost: 'hasSheerForceBoost',
} as const;

function invalid(path: string, reason: string): never {
	throw new Error(`${path}: ${reason}`);
}

function object(value: unknown, path: string, accepted?: readonly string[]): Fields {
	if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(path, 'expected an object');
	const result = value as Fields;
	for (const field of Object.keys(result)) {
		if (accepted && !accepted.includes(field)) invalid(`${path}.${field}`, 'unsupported field');
	}
	return result;
}

function integer(value: unknown, path: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
		invalid(path, `expected an integer from ${min} to ${max}`);
	}
	return value;
}

function bool(value: unknown, path: string): boolean {
	if (typeof value !== 'boolean') invalid(path, 'expected a boolean');
	return value;
}

function string(value: unknown, path: string): string {
	if (typeof value !== 'string' || !value) invalid(path, 'expected a nonempty string');
	return value;
}

function choice<const T extends string>(value: unknown, options: readonly T[], path: string): T {
	const option = options.find(candidate => candidate === value);
	if (option === undefined) invalid(path, `unsupported value ${String(value)}`);
	return option;
}

function lookup<T>(value: unknown, options: ReadonlyMap<string, T>, path: string): T {
	const option = options.get(string(value, path));
	if (option === undefined) invalid(path, `unsupported value ${String(value)}`);
	return option;
}

function list(value: unknown, path: string): unknown[] {
	if (!Array.isArray(value)) invalid(path, 'expected a list');
	return value;
}

function fraction(value: unknown, path: string): [number, number] {
	const fields = object(value, path, ['Numerator', 'Denominator']);
	const denominator = integer(fields.Denominator, `${path}.Denominator`, 1);
	return [integer(fields.Numerator, `${path}.Numerator`, 0, denominator), denominator];
}

function nativeFraction(value: unknown, path: string, numerator: number, denominator: number) {
	const [n, d] = fraction(value, path);
	if (n * denominator !== d * numerator) invalid(path, `the selected condition uses ${numerator}/${denominator}`);
}

function nativeBoolean(value: unknown, path: string, expected: boolean) {
	if (bool(value, path) !== expected) invalid(path, `the selected condition requires ${expected}`);
}

function numeric(value: unknown, path: string): number {
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) invalid(path, 'expected a nonnegative number');
	return value;
}

function strings(value: unknown, path: string): string[] {
	return list(value, path).map((entry, index) => string(entry, `${path}[${index}]`));
}

function nativeOptions(value: unknown, path: string, expected: readonly string[]) {
	const values = strings(value, path);
	if (values.length !== expected.length || !expected.every(option => values.includes(option))) {
		invalid(path, `the selected condition requires ${expected.join(', ')}`);
	}
}

function pokemonRequirement(fields: Fields, path: string, check: PokemonCheck): Requirement {
	const subject = choice(fields.Subject, ['User', 'Target'], `${path}.Subject`);
	return (battle, user, target, move) => {
		const pokemon = subject === 'User' ? user : target;
		return !!pokemon && check(pokemon, battle, user, target, move);
	};
}

function requirement(value: unknown, path: string): Requirement {
	const fields = object(value, path);
	const type = fields.Type;
	const field = (name: string) => `${path}.${name}`;
	const onPokemon = (check: PokemonCheck, ...keys: string[]) => {
		object(fields, path, ['Type', 'Subject', ...keys]);
		return pokemonRequirement(fields, path, check);
	};
	switch (type) {
	case 'AnyOf':
	case 'AllOf': {
		object(fields, path, ['Type', 'Requirements']);
		const predicates = list(fields.Requirements, field('Requirements')).map((entry, index) =>
			requirement(entry, `${field('Requirements')}[${index}]`));
		return (...context) => type === 'AnyOf' ? predicates.some(test => test(...context)) :
			predicates.every(test => test(...context));
	}
	case 'Not': {
		object(fields, path, ['Type', 'Requirement']);
		const predicate = requirement(fields.Requirement, field('Requirement'));
		return (...context) => !predicate(...context);
	}
	case 'RandomChance': {
		object(fields, path, ['Type', 'Chance']);
		const [n, d] = fraction(fields.Chance, field('Chance'));
		return battle => battle.randomChance(n, d);
	}
	case 'HasTarget':
		object(fields, path, ['Type']);
		return (_battle, _user, target) => !!target;
	case 'HasMultipleActiveSlotsPerSide':
		object(fields, path, ['Type']);
		return battle => battle.activePerHalf > 1;
	case 'ActiveSlotsPerSideAtLeast': {
		object(fields, path, ['Type', 'Count']);
		const count = integer(fields.Count, field('Count'), 1, 3);
		return battle => battle.activePerHalf >= count;
	}
	case 'TargetIsAlly':
		object(fields, path, ['Type']);
		return (_battle, user, target) => !!target && user.isAlly(target);
	case 'TargetIsSwitchingOut':
		object(fields, path, ['Type']);
		return (_battle, _user, target) => !!(target?.beingCalledBack || target?.switchFlag);
	case 'UserIsTerastallized': {
		object(fields, path, ['Type', 'TeraType']);
		const tera = fields.TeraType === undefined ? undefined : string(fields.TeraType, field('TeraType'));
		return (_battle, user) => tera === undefined ? !!user.terastallized : user.terastallized === tera;
	}
	case 'HasWeather': {
		object(fields, path, ['Type', 'WeatherIds']);
		const weather = strings(fields.WeatherIds, field('WeatherIds'));
		return battle => weather.includes(battle.field.effectiveWeather());
	}
	case 'HasEffectiveWeather': {
		const weather = strings(fields.WeatherIds, field('WeatherIds'));
		return onPokemon(pokemon => weather.includes(pokemon.effectiveWeather()), 'WeatherIds');
	}
	case 'HasTerrain': {
		object(fields, path, ['Type', 'Terrain']);
		const terrain = string(fields.Terrain, field('Terrain'));
		return battle => battle.field.isTerrain(terrain);
	}
	case 'HasAnyTerrain':
		object(fields, path, ['Type']);
		return battle => !!battle.field.terrain;
	case 'HasFieldCondition': {
		object(fields, path, ['Type', 'Condition']);
		const condition = string(fields.Condition, field('Condition'));
		return battle => !!battle.field.getPseudoWeather(condition);
	}
	case 'HasPokemonType': {
		const pokemonType = string(fields.PokemonType, field('PokemonType'));
		return onPokemon(pokemon => pokemon.hasType(pokemonType), 'PokemonType');
	}
	case 'HasSpeciesForm':
	case 'HasBaseSpecies': {
		const species = string(fields.SpeciesId, field('SpeciesId'));
		return onPokemon(pokemon =>
			(type === 'HasBaseSpecies' ? toID(pokemon.baseSpecies.baseSpecies) : pokemon.species.id) === species,
		'SpeciesId');
	}
	case 'HasVolatile':
	case 'HasNoVolatile': {
		const id = string(fields.VolatileId, field('VolatileId'));
		return onPokemon(pokemon => !!pokemon.volatiles[id] === (type === 'HasVolatile'), 'VolatileId');
	}
	case 'HasStatus':
	case 'DoesNotHaveStatus': {
		const status = choice(fields.StatusId, [...statuses.values()], field('StatusId'));
		return onPokemon(pokemon => (pokemon.status === status) === (type === 'HasStatus'), 'StatusId');
	}
	case 'CanReceiveStatus': {
		const status = choice(fields.StatusId, [...statuses.values()], field('StatusId'));
		return onPokemon(pokemon => pokemon.runStatusImmunity(status), 'StatusId');
	}
	case 'HasAbility': {
		const ability = string(fields.AbilityId, field('AbilityId'));
		return onPokemon(pokemon => pokemon.hasAbility(ability), 'AbilityId');
	}
	case 'HasAnyOfAbilities':
	case 'HasNoneOfAbilities': {
		const abilities = strings(fields.AbilityIds, field('AbilityIds'));
		return onPokemon(pokemon => pokemon.hasAbility(abilities) === (type === 'HasAnyOfAbilities'), 'AbilityIds');
	}
	case 'HasAnyStatus': {
		const ids = list(fields.Statuses, field('Statuses')).map(status => lookup(status, statuses, field('Statuses')));
		return onPokemon(pokemon => ids.includes(pokemon.status), 'Statuses');
	}
	case 'HasHeldItem': {
		const item = string(fields.ItemId, field('ItemId'));
		return onPokemon(pokemon => pokemon.hasItem(item), 'ItemId');
	}
	case 'HasAbilityFlag': {
		const flag = string(fields.AbilityFlag, field('AbilityFlag'));
		return onPokemon(pokemon => !!pokemon.getAbility().flags[flag as keyof ReturnType<Pokemon['getAbility']>['flags']], 'AbilityFlag');
	}
	case 'HasNoHeldItem': return onPokemon(pokemon => !pokemon.item);
	case 'HasAnyHeldItem': return onPokemon(pokemon => !!pokemon.item);
	case 'HasHeldItemKind': {
		const kind = choice(fields.ItemKind, ['Berry', 'Gem'], field('ItemKind'));
		return onPokemon(pokemon => kind === 'Berry' ? !!pokemon.getItem().isBerry : !!pokemon.getItem().isGem, 'ItemKind');
	}
	case 'HasRemovableItem':
		return onPokemon((pokemon, battle, _user, _target, move) => {
			const item = pokemon.getItem();
			return !!item.id && !!battle.singleEvent('TakeItem', item, pokemon.itemState, pokemon, pokemon, move, item);
		});
	case 'UserIsTarget':
		object(fields, path, ['Type']);
		return (_battle, user, target) => user === target;
	case 'WasMoveReflected':
		object(fields, path, ['Type']);
		return (_battle, _user, _target, move) => !!move.hasBounced;
	case 'HasNoMajorStatus': return onPokemon(pokemon => !pokemon.status);
	case 'HasMissingHP': return onPokemon(pokemon => pokemon.hp < pokemon.maxhp);
	case 'HasEatenBerry': return onPokemon(pokemon => pokemon.ateBerry);
	case 'HasNotFainted': return onPokemon(pokemon => !pokemon.fainted && pokemon.hp > 0);
	case 'IsActive': return onPokemon(pokemon => pokemon.isActive);
	case 'IsGrounded': return onPokemon(pokemon => pokemon.isGrounded() === true);
	case 'IsTransformed': return onPokemon(pokemon => pokemon.transformed);
	case 'HasJustSwitchedIn': return onPokemon(pokemon => pokemon.newlySwitched);
	case 'HasLessHPThan': {
		const other = choice(fields.Other, ['User', 'Target'], field('Other'));
		return onPokemon((pokemon, _battle, user, target) => {
			const compared = other === 'User' ? user : target;
			return !!compared && pokemon.hp < compared.hp;
		}, 'Other');
	}
	case 'HasEligibleReserve': return onPokemon((pokemon, battle) => battle.canSwitch(pokemon.side) > 0);
	case 'HasFaintedTeammate': return onPokemon(pokemon => pokemon.side.pokemon.some(ally => ally.fainted));
	case 'HasQueuedMove': return onPokemon((pokemon, battle) => !!battle.queue.willMove(pokemon));
	case 'HasQueuedAttackingMove': {
		const minimum = fields.MinimumMovePriority === undefined ? undefined :
			numeric(fields.MinimumMovePriority, field('MinimumMovePriority'));
		const exceptions = fields.StatusMoveExceptions === undefined ? [] :
			strings(fields.StatusMoveExceptions, field('StatusMoveExceptions'));
		return onPokemon((pokemon, battle) => {
			const action = battle.queue.willMove(pokemon);
			if (action?.choice !== 'move') return false;
			return (minimum === undefined || action.move.priority > minimum) &&
				(action.move.category !== 'Status' || exceptions.includes(action.move.id));
		}, 'MinimumMovePriority', 'StatusMoveExceptions');
	}
	case 'WasDamagedThisTurn': {
		const source = fields.By === undefined ? undefined : choice(fields.By, ['User', 'Target'], field('By'));
		return onPokemon((pokemon, _battle, user, target) => source === undefined ? !!pokemon.hurtThisTurn :
			pokemon.attackedBy.some(attack => attack.thisTurn && attack.damage > 0 &&
				attack.source === (source === 'User' ? user : target)), 'By');
	}
	case 'HasOppositeGender': {
		const relative = choice(fields.RelativeTo, ['User', 'Target'], field('RelativeTo'));
		return onPokemon((pokemon, _battle, user, target) => {
			const other = relative === 'User' ? user : target;
			return !!pokemon.gender && !!other?.gender && pokemon.gender !== other.gender;
		}, 'RelativeTo');
	}
	case 'ActiveMoveActionsAtMost': {
		const max = integer(fields.Count, field('Count'));
		return onPokemon(pokemon => pokemon.activeMoveActions <= max, 'Count');
	}
	case 'ActiveTurnsAtMost': {
		const max = integer(fields.Count, field('Count'));
		return onPokemon(pokemon => pokemon.activeTurns <= max, 'Count');
	}
	case 'UserDamagedByTargetThisTurn':
		object(fields, path, ['Type']);
		return (_battle, user, target) => user.attackedBy.some(attack => attack.source === target && attack.damage > 0 && attack.thisTurn);
	case 'UserAndTargetShareType':
		object(fields, path, ['Type']);
		return (_battle, user, target) => !!target && user.getTypes().some(type => type !== '???' && target.hasType(type));
	case 'UsedAllOtherKnownMoves': {
		object(fields, path, ['Type', 'MinimumKnownMoves', 'RequiresCurrentMoveInMoveset']);
		const min = integer(fields.MinimumKnownMoves, field('MinimumKnownMoves'), 1);
		const requireCurrent = fields.RequiresCurrentMoveInMoveset === undefined ? false :
			bool(fields.RequiresCurrentMoveInMoveset, field('RequiresCurrentMoveInMoveset'));
		return (_battle, user, _target, move) => user.moveSlots.length >= min &&
			(!requireCurrent || user.moveSlots.some(slot => slot.id === move.id)) &&
			user.moveSlots.every(slot => slot.id === move.id || slot.used);
	}
	case 'IsMoveSuperEffective':
		return onPokemon((pokemon, _battle, _user, _target, move) => pokemon.runEffectiveness(move) > 0);
	case 'SideHadFaintLastTurn': return onPokemon(pokemon => !!pokemon.side.faintedLastTurn);
	case 'FailedMoveLastTurn': return onPokemon(pokemon => pokemon.moveLastTurnResult === false);
	case 'HadStatsLoweredThisTurn': return onPokemon(pokemon => pokemon.statsLoweredThisTurn);
	case 'RaisedStatsThisTurn': return onPokemon(pokemon => pokemon.statsRaisedThisTurn);
	case 'LastSuccessfulMoveIs': {
		object(fields, path, ['Type', 'MoveId', 'SameTurn']);
		const move = string(fields.MoveId, field('MoveId'));
		if (!bool(fields.SameTurn, field('SameTurn'))) invalid(field('SameTurn'), 'expected true');
		return battle => battle.lastSuccessfulMoveThisTurn === move;
	}
	case 'MoveHasNoSheerForce':
	case 'HasNoSheerForceBoost':
		object(fields, path, ['Type']);
		return (_battle, _user, _target, move) => !move.hasSheerForce;
	case 'WasMoveSnatched':
		object(fields, path, ['Type']);
		return (_battle, _user, _target, move) => move.sourceEffect === 'snatch';
	case 'CalledBySameMove':
		object(fields, path, ['Type']);
		return (_battle, _user, _target, move) => move.sourceEffect === move.id;
	case 'HPFractionAbove':
	case 'HPFractionAtMost': {
		const [n, d] = fraction(fields.Fraction, field('Fraction'));
		return onPokemon(pokemon => (pokemon.hp * d > pokemon.maxhp * n) === (type === 'HPFractionAbove'), 'Fraction');
	}
	case 'MaxHPAbove': {
		const threshold = integer(fields.HP, field('HP'));
		return onPokemon(pokemon => pokemon.maxhp > threshold, 'HP');
	}
	case 'StatStageBelow': {
		const stat = lookup(fields.Stat, stages, field('Stat'));
		const max = integer(fields.Stage, field('Stage'), -6, 6);
		return onPokemon(pokemon => pokemon.boosts[stat] < max, 'Stat', 'Stage');
	}
	case 'CanChangeStat': {
		const stat = lookup(fields.Stat, stages, field('Stat'));
		const amount = integer(fields.StageDelta, field('StageDelta'), -6, 6);
		const contrary = fields.RespectContrary === undefined ? false : bool(fields.RespectContrary, field('RespectContrary'));
		return onPokemon(pokemon => {
			const delta = contrary && pokemon.hasAbility('contrary') ? -amount : amount;
			return delta > 0 ? pokemon.boosts[stat] < 6 : delta < 0 && pokemon.boosts[stat] > -6;
		}, 'Stat', 'StageDelta', 'RespectContrary');
	}
	default:
		return invalid(field('Type'), `unsupported requirement ${String(type)}`);
	}
}

function requirements(value: unknown, path: string): Requirement {
	const predicates = value === undefined ? [] : list(value, path).map((entry, index) =>
		requirement(entry, `${path}[${index}]`));
	return (...context) => predicates.every(predicate => predicate(...context));
}

function activePokemon(value: unknown, path: string) {
	const subject = choice(value, ['User', 'Target'], path);
	return (user: Pokemon, target: Pokemon) => subject === 'User' ? user : target;
}

function basePowerCalculation(move: MoveData, path: string, calculate: NonNullable<MoveData['basePowerCallback']>) {
	if (move.basePowerCallback) invalid(path, 'already has a base power calculation');
	move.basePowerCallback = calculate;
}

function healingAmount(effect: Fields, path: string, basis = effect.HPBasis) {
	const field = (name: string) => `${path}.${name}`;
	const hp = basis === undefined ? 'BaseMaxHP' : choice(basis, ['MaxHP', 'BaseMaxHP'], field('HPBasis'));
	const rounding = effect.Rounding === undefined ? 'Nearest' :
		choice(effect.Rounding, ['Ceiling', 'Floor', 'Nearest', 'ShowdownFixedPoint'], field('Rounding'));
	const [n, d] = fraction(effect.Fraction, field('Fraction'));
	return (battle: Battle, pokemon: Pokemon): number => {
		const maxhp = hp === 'MaxHP' ? pokemon.maxhp : pokemon.baseMaxhp;
		if (rounding === 'ShowdownFixedPoint') return battle.modify(maxhp, n / d);
		const round = { Ceiling: Math.ceil, Floor: Math.floor, Nearest: Math.round }[rounding];
		return round(maxhp * n / d);
	};
}


// These profiles select an existing engine condition. Altering its internal rules requires
// a separate configurable effect, so validate every configured field before selecting it.
const nativeConditionProfiles: readonly [NativeHitEffect, Fields][] = [
	[{ volatileStatus: 'minimize' }, {"Type":"ModifyIncomingAttacks","ConditionId":"minimize","CanBeCopied":false,"AlwaysHits":true,"DamageMultiplier":2,"RequiredFlag":"minimize","IgnoreOnReapply":true}],
	[{ volatileStatus: 'grudge' }, {"Type":"DrainAttackerPPOnFaint","ConditionId":"grudge","DamageFromMovesOnly":true,"ExcludedFlags":["futuremove"],"UseMaxBaseMove":true,"EndsBeforeNextMove":true,"BeforeMovePriority":100}],
	[{ volatileStatus: 'imprison' }, {"Type":"BlockSharedMoves","ConditionId":"imprison","CanBeCopied":false,"BeforeMovePriority":4,"ExcludedMoveIds":["struggle"],"AllowZOrMaxPowered":true}],
	[{ volatileStatus: 'magiccoat' }, {"Type":"ReflectIncomingMoves","ConditionId":"magiccoat","DurationTurns":1,"Priority":2,"RequiredFlag":"reflectable","ReflectSideTargetedMoves":true,"RespectSemiInvulnerability":true,"PreservePranksterForSingleTarget":true}],
	[{ volatileStatus: 'octolock' }, {"Type":"TrapAndLowerStats","ConditionId":"octolock","RespectsTrapImmunity":true,"ResidualOrder":14,"RequireActiveSource":true,"RequireSourceHasTakenTurn":true,"Effect":{"Type":"ChangeStats","Stages":{"Defense":-1,"SpecialDefense":-1}}}],
	[{ volatileStatus: 'rage' }, {"Type":"BoostOnIncomingDamage","ConditionId":"rage","Effect":{"Type":"ChangeStats","Stages":{"Attack":1}},"ExcludeSelfDamage":true,"SkipStatusMoves":true,"EndsBeforeNextMove":true,"BeforeMovePriority":100}],
	[{ volatileStatus: 'roost' }, {"Type":"RemoveUserTypeUntilTurnEnd","ConditionId":"roost","PokemonType":"Flying","SkipTerastallized":true,"ResidualOrder":25,"TypePriority":-1}],
	[{ volatileStatus: 'tarshot' }, {"Type":"ModifyIncomingTypeEffectiveness","ConditionId":"tarshot","MoveType":"Fire","Stages":1,"Priority":-2,"OnlyFirstType":true,"BlockIfTargetTerastallized":true}],
	[{ volatileStatus: 'uproar' }, {"Type":"LockMoveAndBlockStatus","ConditionId":"uproar","DurationTurns":3,"BlockedStatusId":"slp","BannedUserVolatiles":["throatchop"],"EndOnStruggle":true,"ResidualOrder":28,"ResidualSubOrder":1}],
	[{ pseudoWeather: 'fairylock' }, {"Type":"TrapField","FieldConditionId":"fairylock","DurationTurns":2}],
	[{ volatileStatus: 'laserfocus' }, {"Type":"GuaranteeCriticalHits","ConditionId":"laserfocus","DurationTurns":2,"CriticalRatio":5,"RefreshOnRepeat":true,"SilentWhenCopiedByAbilities":["costar","imposter"],"SilentWhenCopiedByMoves":["psychup","transform"]}],
	[{ volatileStatus: 'magnetrise' }, {"Type":"GrantTypeImmunity","ConditionId":"magnetrise","DurationTurns":5,"PokemonType":"Ground","ResidualOrder":18}],
	[{ volatileStatus: 'leechseed' }, {"Type":"DrainResidualDamageToSourceSlot","ConditionId":"leechseed","Fraction":{"Numerator":1,"Denominator":8},"HPBasis":"BaseMaxHP","ResidualOrder":8}],
	[{ volatileStatus: 'syrupbomb' }, {"Type":"ApplyResidualEffect","ConditionId":"syrupbomb","DurationTurns":4,"CanBeCopied":false,"EndWhenSourceLeavesField":true,"ResidualOrder":14,"Effect":{"Type":"ChangeStats","Stages":{"Speed":-1}}}],
	[{ volatileStatus: 'saltcure' }, {"Type":"ApplyResidualDamage","ConditionId":"saltcure","HPBasis":"BaseMaxHP","Fraction":{"Numerator":1,"Denominator":8},"ResidualOrder":13,"CanBeCopied":false,"TypeOverride":{"PokemonTypes":["Water","Steel"],"Fraction":{"Numerator":1,"Denominator":4}}}],
	[{ volatileStatus: 'taunt' }, {"Type":"DisableMovesByFilter","ConditionId":"taunt","DurationTurns":3,"Categories":["Status"],"ExcludedMoveIds":["mefirst"],"AllowZPowered":true,"ExtendIfTargetAlreadyMoved":true,"BeforeMovePriority":5,"ResidualOrder":15}],
	[{ volatileStatus: 'throatchop' }, {"Type":"DisableMovesByFilter","ConditionId":"throatchop","DurationTurns":2,"Flags":["sound"],"AllowZPowered":true,"AllowMaxPowered":true,"RecheckOnModifyMove":true,"BeforeMovePriority":6,"ResidualOrder":22,"Silent":true}],
	[{ volatileStatus: 'torment' }, {"Type":"PreventConsecutiveMove","ConditionId":"torment","CanBeCopied":false,"BlockedByVolatile":"dynamax","ExcludedMoveIds":["struggle"],"DurationOverride":{"MoveId":"gmaxmeltdown","DurationTurns":3}}],
	[{ volatileStatus: 'yawn' }, {"Type":"ApplyStatusWhenVolatileEnds","ConditionId":"yawn","DurationTurns":2,"StatusId":"slp","CanBeCopied":false,"ResidualOrder":23}],
	[{ pseudoWeather: 'magicroom' }, {"Type":"SuppressFieldItems","ConditionId":"magicroom","DurationTurns":5,"ToggleOffOnRepeat":true,"DurationOverride":{"AbilityId":"persistent","DurationTurns":7},"ResidualOrder":27,"ResidualSubOrder":6}],
	[{ sideCondition: 'mist' }, {"Type":"PreventExternalStatDrops","ConditionId":"mist","DurationTurns":5,"BypassedByFoesWithInfiltration":true,"ResidualOrder":26,"ResidualSubOrder":4}],
	[{ sideCondition: 'safeguard' }, {"Type":"PreventExternalStatus","ConditionId":"safeguard","DurationTurns":5,"BypassedByFoesWithInfiltration":true,"DurationOverride":{"AbilityId":"persistent","DurationTurns":7},"BlockedVolatiles":["confusion","yawn"],"ExcludedStatusSourceMoveIds":["yawn"],"ResidualOrder":26,"ResidualSubOrder":3}],
	[{ pseudoWeather: 'watersport' }, {"Type":"MultiplyFieldMovePower","ConditionId":"watersport","DurationTurns":5,"MoveType":"Fire","Multiplier":{"Numerator":1352,"Denominator":4096},"Priority":1,"ResidualOrder":27,"ResidualSubOrder":3}],
	[{ sideCondition: 'tailwind' }, {"Type":"MultiplySideStat","ConditionId":"tailwind","Stat":"Speed","Multiplier":2,"DurationTurns":4,"DurationOverride":{"AbilityId":"persistent","DurationTurns":6},"ResidualOrder":26,"ResidualSubOrder":5}],
	[{ volatileStatus: 'helpinghand' }, {"Type":"BoostOutgoingPower","ConditionId":"helpinghand","DurationTurns":1,"Multiplier":1.5,"Priority":10,"MultiplyOnRestart":true}],
	[{ volatileStatus: 'electrify' }, {"Type":"SetOutgoingMoveType","ConditionId":"electrify","DurationTurns":1,"MoveType":"Electric","Priority":-2,"ExcludedMoveIds":["struggle"]}],
	[{ volatileStatus: 'glaiverush' }, {"Type":"ModifyIncomingAttacks","ConditionId":"glaiverush","CanBeCopied":false,"AlwaysHits":true,"DamageMultiplier":2,"EndsBeforeNextMove":true,"BeforeMovePriority":100}],
	[{ volatileStatus: 'stockpile' }, {"Type":"StackVolatileWithStats","ConditionId":"stockpile","MaximumLayers":3,"CanBeCopied":false,"OnAddLayer":{"Type":"ChangeStats","Stages":{"Defense":1,"SpecialDefense":1}},"RevertActualBoostsOnEnd":true}],
	[{ volatileStatus: 'powertrick' }, {"Type":"SwapOwnStoredStats","ConditionId":"powertrick","FirstStat":"Attack","SecondStat":"Defense","ReapplyOnCopy":true,"ToggleOffOnRepeat":true}],
	[{ volatileStatus: 'disable' }, {"Type":"DisableLastMove","ConditionId":"disable","DurationTurns":5,"CanBeCopied":false,"ResidualOrder":17,"BeforeMovePriority":7,"RequiresPP":true,"ExcludedMoveIds":["struggle"],"ExcludeZOrMaxPowered":true,"ExcludeMaxMoves":true,"ShortenWhenTargetHasQueuedMove":true,"ShortenWhenTargetIsMovingInternally":true,"AllowZUseOfDisabledMove":true}],
	[{ volatileStatus: 'encore' }, {"Type":"RepeatLastMove","ConditionId":"encore","DurationTurns":3,"CanBeCopied":false,"ResidualOrder":16,"RequiresPP":true,"UseMaxBaseMove":true,"ExcludeZMoves":true,"ExcludeMaxMoves":true,"ExcludedFlags":["failencore"],"BlockedByVolatile":"dynamax","ExtendWhenTargetHasNoQueuedMove":true,"EndWhenMoveUnavailable":true}],
];

function sameConfig(value: unknown, expected: unknown): boolean {
	if (value === expected) return true;
	if (!value || !expected || typeof value !== 'object' || typeof expected !== 'object') return false;
	if (Array.isArray(value) !== Array.isArray(expected)) return false;
	const actual = value as Fields;
	const wanted = expected as Fields;
	const keys = Object.keys(wanted);
	return Object.keys(actual).length === keys.length &&
		keys.every(key => Object.hasOwn(actual, key) && sameConfig(actual[key], wanted[key]));
}

function matchProfile(value: unknown, expected: unknown, path: string) {
	if (!sameConfig(value, expected)) invalid(path, 'configuration differs from the supported rule');
}

function nativeCondition(effect: Fields, path: string): NativeHitEffect | undefined {
	const profiles = nativeConditionProfiles.filter(([, expected]) => expected.Type === effect.Type);
	const match = profiles.find(([, expected]) => sameConfig(effect, expected));
	if (match) return { ...match[0] };
	if (profiles.length) invalid(path, 'configuration differs from the selected native condition');
}

function eventEffect(value: unknown, path: string): EffectAction {
	const effect = object(value, path);
	const keys = (...fields: string[]) => object(effect, path, ['Type', ...fields]);
	switch (effect.Type) {
	case 'SwapSideConditions': {
		keys('Conditions', 'FreeForAllOrder');
		const conditions = new Set(strings(effect.Conditions, `${path}.Conditions`));
		const order = strings(effect.FreeForAllOrder, `${path}.FreeForAllOrder`);
		nativeOptions(order, `${path}.FreeForAllOrder`, ['p1', 'p2', 'p3', 'p4']);
		return (battle, _target, user, move) => {
			const sides = battle.gameType === 'freeforall' ? order.map(id => battle.sides[Number(id[1]) - 1]) :
				[user.side, user.side.foe];
			const transferred = sides.map(side => Object.entries(side.sideConditions).filter(([id]) => {
				if (!conditions.has(id)) return false;
				delete side.sideConditions[id];
				return true;
			}));
			if (!transferred.some(entries => entries.length)) return false;
			for (const [index, entries] of transferred.entries()) {
				const side = sides[(index + 1) % sides.length];
				for (const [id, state] of entries) {
					side.sideConditions[id] = state;
					state.target = side;
				}
			}
			battle.add('-swapsideconditions');
			battle.add('-activate', user, `move: ${move.name}`);
			return true;
		};
	}
	case 'QueueLastMove': {
		keys('BlockedByVolatiles', 'ExcludedFlags', 'ExcludeZMoves', 'ExcludeMaxMoves', 'CheckPPIfMoveInSlot', 'ReuseTargetSlot');
		const blocked = strings(effect.BlockedByVolatiles, `${path}.BlockedByVolatiles`);
		const flags = strings(effect.ExcludedFlags, `${path}.ExcludedFlags`);
		const z = bool(effect.ExcludeZMoves, `${path}.ExcludeZMoves`);
		const max = bool(effect.ExcludeMaxMoves, `${path}.ExcludeMaxMoves`);
		const pp = bool(effect.CheckPPIfMoveInSlot, `${path}.CheckPPIfMoveInSlot`);
		const reuse = bool(effect.ReuseTargetSlot, `${path}.ReuseTargetSlot`);
		return (battle, target, user, move) => {
			const last = target.lastMove;
			if (!last || (z && last.isZ) || (max && last.isMax) || blocked.some(id => target.volatiles[id]) ||
				flags.some(flag => last.flags[flag as keyof typeof last.flags])) return false;
			const slot = target.getMoveData(last.id);
			if (pp && slot && slot.pp <= 0) return false;
			battle.add('-singleturn', target, `move: ${move.name}`, `[of] ${user}`);
			const [action] = battle.queue.resolveAction({
				choice: 'move', pokemon: target, moveid: last.id, targetLoc: reuse ? target.lastMoveTargetLoc! : 0,
			});
			battle.queue.prioritizeAction(action as MoveAction);
			return true;
		};
	}
	case 'ForEachPokemon': {
		keys('Selection', 'Requirements', 'RespectVolatileGuard', 'AnnounceGroundImmunity', 'Effect', 'CheckInvulnerability', 'RunTryHitEvent');
		const selection = choice(effect.Selection, ['AllActive', 'AlliedSideActive', 'UserAndActiveAllies', 'TargetAdjacentAllies'],
			`${path}.Selection`);
		const guard = effect.RespectVolatileGuard === undefined ? undefined :
			string(effect.RespectVolatileGuard, `${path}.RespectVolatileGuard`);
		const announceImmunity = effect.AnnounceGroundImmunity === undefined ? false :
			bool(effect.AnnounceGroundImmunity, `${path}.AnnounceGroundImmunity`);
		const applies = requirements(effect.Requirements, `${path}.Requirements`);
		const check = effect.CheckInvulnerability !== undefined && bool(effect.CheckInvulnerability, `${path}.CheckInvulnerability`);
		const tryHit = effect.RunTryHitEvent !== undefined && bool(effect.RunTryHitEvent, `${path}.RunTryHitEvent`);
		const action = eventEffect(effect.Effect, `${path}.Effect`);
		const kind = object(effect.Effect, `${path}.Effect`).Type;
		const perish = kind === 'PerishCountdown';
		const berry = kind === 'EatHeldBerry';
		const resetsAll = selection === 'AllActive' && effect.Requirements === undefined && !guard && !announceImmunity &&
			object(effect.Effect, `${path}.Effect`).Type === 'ResetStatStages';
		return (battle, target, user, move) => {
			let success = false;
			let applied = false;
			const selected = selection === 'AllActive' ? battle.getAllActive() :
				selection === 'TargetAdjacentAllies' ? target.adjacentAllies() : user.side.allies();
			if (resetsAll) battle.add('-clearallboost');
			if (berry) battle.add('-fieldactivate', `move: ${move.name}`);
			for (const pokemon of selected) {
				if (check && battle.runEvent('Invulnerability', pokemon, user, move) === false) {
					battle.add('-miss', user, pokemon);
					success ||= perish;
					continue;
				}
				if (announceImmunity && !pokemon.runImmunity('Ground')) {
					battle.add('-immune', pokemon);
					success = true;
					continue;
				}
				if (!applies(battle, user, pokemon, move)) continue;
				if (tryHit) {
					const hit = battle.runEvent('TryHit', pokemon, user, move);
					if (perish ? hit === null : !hit) { success ||= perish; continue; }
				}
				if (guard && pokemon.volatiles[guard] && !battle.runEvent('TryHit', pokemon, user, move)) continue;
				if (action(battle, pokemon, user, move)) applied = true;
			}
			if (perish && applied) battle.add('-fieldactivate', `move: ${move.name}`);
			return success || applied;
		};
	}
	case 'ResetStatStages':
		keys();
		return (_battle, target) => { target.clearBoosts(); return true; };
	case 'PerishCountdown': {
		keys('ConditionId', 'DurationTurns', 'ResidualOrder');
		const id = choice(effect.ConditionId, ['perishsong'], `${path}.ConditionId`);
		integer(effect.DurationTurns, `${path}.DurationTurns`, 4, 4);
		integer(effect.ResidualOrder, `${path}.ResidualOrder`, 24, 24);
		return (battle, target, user, move) => {
			if (target.volatiles[id] || !target.addVolatile(id, user, move)) return false;
			battle.add('-start', target, 'perish3', '[silent]');
			return true;
		};
	}
	case 'EatHeldBerry': {
		keys('Forced');
		const forced = bool(effect.Forced, `${path}.Forced`);
		return (_battle, pokemon) => pokemon.getItem().isBerry && !!pokemon.eatItem(forced);
	}
	case 'CureStatusOnHitTargets': {
		keys('StatusId', 'MarkerConditionId', 'AllowUnmarkedOnMultiTarget', 'ExcludeUser', 'RequireActiveTarget', 'ClearMarkersIfUserFaints');
		const status = choice(effect.StatusId, [...statuses.values()], `${path}.StatusId`);
		const marker = string(effect.MarkerConditionId, `${path}.MarkerConditionId`);
		const multi = bool(effect.AllowUnmarkedOnMultiTarget, `${path}.AllowUnmarkedOnMultiTarget`);
		const exclude = bool(effect.ExcludeUser, `${path}.ExcludeUser`);
		const active = bool(effect.RequireActiveTarget, `${path}.RequireActiveTarget`);
		const clear = bool(effect.ClearMarkersIfUserFaints, `${path}.ClearMarkersIfUserFaints`);
		return (battle, _target, user, move) => {
			if (user.fainted || !move.hitTargets || move.hasSheerForce) {
				if (clear) for (const pokemon of battle.getAllActive()) delete pokemon.volatiles[marker];
				return false;
			}
			let healed = false;
			for (const pokemon of move.hitTargets) {
				if ((!exclude || pokemon !== user) && (!active || pokemon.isActive) &&
					(pokemon.removeVolatile(marker) || (multi && move.hitTargets.length > 1)) && pokemon.status === status &&
					pokemon.cureStatus()) healed = true;
			}
			return healed;
		};
	}
	case 'Sequence': {
		keys('Effects', 'StopOnFailure');
		const actions = list(effect.Effects, `${path}.Effects`).map((entry, index) =>
			eventEffect(entry, `${path}.Effects[${index}]`));
		if (!actions.length) invalid(`${path}.Effects`, 'expected at least one effect');
		const stop = effect.StopOnFailure === undefined ? false : bool(effect.StopOnFailure, `${path}.StopOnFailure`);
		return (...context) => {
			let success = false;
			for (const action of actions) {
				const result = action(...context);
				if (!result && stop) return false;
				success ||= result;
			}
			return success;
		};
	}
	case 'ChangeStats': {
		keys('Stages');
		const changes = stageChanges(effect.Stages, `${path}.Stages`);
		return (battle, target, user, move) => !!battle.boost(changes, target, user, move);
	}
	case 'ChangeRandomStat': {
		keys('StageDelta', 'EligibleStats', 'ExcludeAtOrAboveStage');
		const delta = integer(effect.StageDelta, `${path}.StageDelta`, -6, 6);
		const max = integer(effect.ExcludeAtOrAboveStage, `${path}.ExcludeAtOrAboveStage`, -6, 6);
		const eligible = list(effect.EligibleStats, `${path}.EligibleStats`).map(stat => lookup(stat, stages, `${path}.EligibleStats`));
		return (battle, target, user, move) => {
			const options = eligible.filter(stat => target.boosts[stat] < max);
			if (!options.length) return false;
			battle.boost({ [battle.sample(options)]: delta }, target, user, move);
			return true;
		};
	}
	case 'MaximizeStat': {
		keys('Stat');
		const stat = lookup(effect.Stat, stages, `${path}.Stat`);
		return (battle, target, user, move) => !!battle.boost({ [stat]: 12 }, target, user, move);
	}
	case 'ChangeWeight': {
		keys('Kilograms', 'MinimumKilograms');
		const minimum = Math.ceil(10 * numeric(effect.MinimumKilograms, `${path}.MinimumKilograms`));
		const amount = typeof effect.Kilograms === 'number' ? effect.Kilograms * 10 : NaN;
		if (!Number.isSafeInteger(amount)) invalid(`${path}.Kilograms`, 'expected a weight in tenths of a kilogram');
		return (battle, pokemon, _user, move) => {
			const weight = Math.max(minimum, pokemon.weighthg + amount);
			if (weight === pokemon.weighthg) return false;
			pokemon.weighthg = weight;
			battle.add('-start', pokemon, move.name);
			return true;
		};
	}
	case 'PrioritizeQueuedMove': {
		keys('Requirements');
		const applies = requirements(effect.Requirements, `${path}.Requirements`);
		return (battle, target, user, move) => {
			if (!applies(battle, user, target, move)) return false;
			const action = battle.queue.willMove(target);
			if (!action) return false;
			battle.queue.prioritizeAction(action);
			battle.add('-activate', target, `move: ${move.name}`);
			return true;
		};
	}
	case 'CallTargetLastMove': {
		keys('RequiredFlag', 'ExcludeZMoves', 'ExcludeMaxMoves');
		const flag = string(effect.RequiredFlag, `${path}.RequiredFlag`);
		const z = bool(effect.ExcludeZMoves, `${path}.ExcludeZMoves`);
		const max = bool(effect.ExcludeMaxMoves, `${path}.ExcludeMaxMoves`);
		return (battle, target, user) => {
			const last = target.lastMove;
			if (!last || !last.flags[flag as keyof typeof last.flags] || (z && last.isZ) || (max && last.isMax)) return false;
			battle.actions.useMove(last.id, user, { target });
			return true;
		};
	}
	case 'CallMoveByTerrain': {
		keys('DefaultMoveId', 'Overrides');
		const fallback = string(effect.DefaultMoveId, `${path}.DefaultMoveId`);
		const overrides = list(effect.Overrides, `${path}.Overrides`).map((value, i) => {
			const location = `${path}.Overrides[${i}]`;
			const entry = object(value, location, ['Terrain', 'MoveId']);
			return { terrain: string(entry.Terrain, `${location}.Terrain`), id: string(entry.MoveId, `${location}.MoveId`) };
		});
		return (battle, target, user) => {
			const id = overrides.find(entry => battle.field.isTerrain(entry.terrain))?.id ?? fallback;
			battle.actions.useMove(publishedMoveId(battle, id), user, { target });
			return true;
		};
	}
	case 'DelayQueuedMove': {
		keys('MinimumActiveSlotsPerSide', 'Order');
		const minimum = integer(effect.MinimumActiveSlotsPerSide, `${path}.MinimumActiveSlotsPerSide`, 1);
		integer(effect.Order, `${path}.Order`, 201, 201);
		return (battle, target, _user, move) => {
			if (battle.activePerHalf < minimum) return false;
			const action = battle.queue.willMove(target);
			if (!action) return false;
			action.order = 201;
			battle.add('-activate', target, `move: ${move.name}`);
			return true;
		};
	}
	case 'ChangeStatsBeforeUserSwitch': {
		keys('Stages', 'AllowSwitchIfTargetHasAbility');
		const change = stageChanges(effect.Stages, `${path}.Stages`);
		const exception = string(effect.AllowSwitchIfTargetHasAbility, `${path}.AllowSwitchIfTargetHasAbility`);
		return (battle, target, user, move) => {
			if (!battle.boost(change, target, user) && !target.hasAbility(exception)) delete move.selfSwitch;
			return true;
		};
	}
	case 'DeductLastMovePP': {
		keys('PP', 'SkipZMoves', 'UseMaxBaseMove', 'RequiresLivingTarget');
		const pp = integer(effect.PP, `${path}.PP`, 1);
		const skipZ = bool(effect.SkipZMoves, `${path}.SkipZMoves`);
		const useBase = bool(effect.UseMaxBaseMove, `${path}.UseMaxBaseMove`);
		const living = effect.RequiresLivingTarget === undefined ? false : bool(effect.RequiresLivingTarget, `${path}.RequiresLivingTarget`);
		return (battle, target, _user, move) => {
			if (living && !target.hp) return false;
			let last: Move | ActiveMove | null = target.lastMove;
			if (!last || (skipZ && last.isZ)) return false;
			if (useBase && last.isMax && last.baseMove) last = battle.dex.moves.get(last.baseMove);
			const deducted = target.deductPP(last.id, pp);
			if (!deducted) return false;
			battle.add('-activate', target, `move: ${move.name}`, last.name, deducted);
			return true;
		};
	}
	case 'ApplyStatus': {
		keys('Status', 'DurationTurns', 'ReplaceExisting');
		const status = lookup(effect.Status, statuses, `${path}.Status`);
		const replace = effect.ReplaceExisting === undefined ? false : bool(effect.ReplaceExisting, `${path}.ReplaceExisting`);
		const duration = effect.DurationTurns === undefined ? undefined : integer(effect.DurationTurns, `${path}.DurationTurns`, 1);
		if (duration !== undefined && status !== 'slp') invalid(`${path}.DurationTurns`, 'only sleep has a configurable turn counter');
		return (_battle, target, user, move) => {
			const applied = replace ? target.setStatus(status, user, move) : target.trySetStatus(status, user, move);
			if (applied && duration !== undefined) {
				target.statusState.time = duration + 1;
				target.statusState.startTime = duration + 1;
			}
			return !!applied;
		};
	}
	case 'ApplyVolatile': {
		keys('Condition');
		const condition = string(effect.Condition, `${path}.Condition`);
		return (_battle, target, user, move) => !!target.addVolatile(condition, user, move);
	}
	case 'CureMajorStatus':
		keys();
		return (_battle, target) => target.cureStatus();
	case 'Heal':
	case 'HealUser': {
		keys('HPBasis', 'Fraction', 'Rounding');
		const amount = healingAmount(effect, path);
		const self = effect.Type === 'HealUser';
		return (battle, target, user, move) => {
			const recipient = self ? user : target;
			const protocol = move.id === 'nomelatrest' || move.id === 'rest' ? battle.dex.getActiveMove('rest') : null;
			return !!battle.heal(amount(battle, recipient), recipient, null, protocol);
		};
	}
	case 'BoostNextMoveOfType':
		keys('ConditionId', 'MoveType', 'Multiplier', 'Priority', 'ConsumeOnUse', 'ConsumeOnAbortedUse', 'IgnoreApplyingMove');
		return (_battle, target, user, move) => !!target.addVolatile(move.id, user, move);
	case 'PayHP': {
		keys('Fraction', 'HPBasis', 'Recipient');
		const [n, d] = fraction(effect.Fraction, `${path}.Fraction`);
		const hp = choice(effect.HPBasis, ['MaxHP', 'BaseMaxHP'], `${path}.HPBasis`);
		const recipient = effect.Recipient === undefined ? 'Target' : choice(effect.Recipient, ['User', 'Target'], `${path}.Recipient`);
		return (battle, target, user, move) => {
			const pokemon = recipient === 'User' ? user : target;
			const basis = hp === 'MaxHP' ? pokemon.maxhp : pokemon.baseMaxhp;
			return !!battle.directDamage(basis * n / d, pokemon, user, move);
		};
	}
	case 'SetAbility': {
		keys('AbilityId', 'BlockedAbilityFlags', 'BlockedAbilityIds', 'CureStatusId');
		const id = string(effect.AbilityId, `${path}.AbilityId`);
		const flags = effect.BlockedAbilityFlags === undefined ? [] : strings(effect.BlockedAbilityFlags, `${path}.BlockedAbilityFlags`);
		const blocked = effect.BlockedAbilityIds === undefined ? [] : strings(effect.BlockedAbilityIds, `${path}.BlockedAbilityIds`);
		const cure = effect.CureStatusId === undefined ? undefined : choice(effect.CureStatusId, [...statuses.values()], `${path}.CureStatusId`);
		return (_battle, target, user) => {
			const ability = target.getAbility();
			if (blocked.includes(ability.id) || flags.some(flag => ability.flags[flag as keyof typeof ability.flags])) return false;
			const oldAbility = target.setAbility(id, user);
			if (!oldAbility) return oldAbility === '';
			if (cure && target.status === cure) target.cureStatus();
			return true;
		};
	}
	case 'ChangeSpeciesFormByHP': {
		keys('Threshold', 'AtOrBelow', 'Above');
		const [n, d] = fraction(effect.Threshold, `${path}.Threshold`);
		const below = string(effect.AtOrBelow, `${path}.AtOrBelow`);
		const above = string(effect.Above, `${path}.Above`);
		return (_battle, pokemon, _user, move) =>
			!!pokemon.formeChange(pokemon.hp * d <= pokemon.maxhp * n ? below : above, move);
	}
	case 'ClearTerrain':
		keys();
		return battle => battle.field.clearTerrain();
	case 'SetSideCondition': {
		keys('Condition', 'Scope');
		const id = string(effect.Condition, `${path}.Condition`);
		const foe = effect.Scope === undefined ? false : choice(effect.Scope, ['FoeSides'], `${path}.Scope`) === 'FoeSides';
		return (_battle, target, user, move) => {
			const sides = foe ? user.side.foeSidesWithConditions() : [target.side];
			return sides.map(side => side.addSideCondition(id, user, move)).some(Boolean);
		};
	}
	case 'ApplyEntryHazard': {
		const { ApplyToFoeSides, ...hazard } = effect;
		const id = entryHazard(hazard, path);
		const foe = ApplyToFoeSides === undefined ? false : bool(ApplyToFoeSides, `${path}.ApplyToFoeSides`);
		return (_battle, target, user, move) => {
			const sides = foe ? user.side.foeSidesWithConditions() : [target.side];
			return sides.map(side => side.addSideCondition(id, user, move)).some(Boolean);
		};
	}
	case 'ClearOwnTrapsAndHazards': {
		keys('Volatiles', 'SideConditions');
		const volatiles = strings(effect.Volatiles, `${path}.Volatiles`);
		const conditions = strings(effect.SideConditions, `${path}.SideConditions`);
		return (battle, pokemon, _user, move) => {
			let changed = false;
			for (const id of volatiles) {
				if (!pokemon.removeVolatile(id)) continue;
				changed = true;
				if (id === 'leechseed') battle.add('-end', pokemon, 'Leech Seed', `[from] move: ${move.name}`, `[of] ${pokemon}`);
			}
			for (const id of conditions) {
				if (!pokemon.side.removeSideCondition(id)) continue;
				changed = true;
				battle.add('-sideend', pokemon.side, battle.dex.conditions.get(id).name, `[from] move: ${move.name}`, `[of] ${pokemon}`);
			}
			return changed;
		};
	}
	case 'ClearBattlefield': {
		keys('SideConditions', 'SuccessTriggers', 'Volatiles', 'TargetStatChange', 'ClearTerrain');
		const triggers = new Set(list(effect.SuccessTriggers, `${path}.SuccessTriggers`).map(trigger =>
			choice(trigger, ['TargetSideConditionRemoved', 'BothSidesConditionRemoved', 'VolatileRemoved', 'TargetStatChange'], `${path}.SuccessTriggers`)));
		const sides = effect.SideConditions === undefined ? {} :
			object(effect.SideConditions, `${path}.SideConditions`, ['TargetOnly', 'BothSides']);
		const targetOnly = strings(sides.TargetOnly ?? [], `${path}.SideConditions.TargetOnly`);
		const both = strings(sides.BothSides ?? [], `${path}.SideConditions.BothSides`);
		const volatiles = strings(effect.Volatiles ?? [], `${path}.Volatiles`);
		const terrain = effect.ClearTerrain !== undefined && bool(effect.ClearTerrain, `${path}.ClearTerrain`);
		const stat = effect.TargetStatChange === undefined ? undefined :
			object(effect.TargetStatChange, `${path}.TargetStatChange`, ['Effect', 'BlockedBySubstitute', 'RespectInfiltration']);
		const change = stat ? eventEffect(stat.Effect, `${path}.TargetStatChange.Effect`) : undefined;
		const blocks = stat ? bool(stat.BlockedBySubstitute, `${path}.TargetStatChange.BlockedBySubstitute`) : false;
		const infiltrates = stat ? bool(stat.RespectInfiltration, `${path}.TargetStatChange.RespectInfiltration`) : false;
		return (battle, target, user, move) => {
			const applied = new Set<string>();
			if (change && (!blocks || !target.volatiles['substitute'] || (infiltrates && move.infiltrates)) &&
				change(battle, target, user, move)) applied.add('TargetStatChange');
			for (const pokemon of battle.getAllActive()) {
				for (const id of volatiles) if (pokemon.removeVolatile(id)) applied.add('VolatileRemoved');
			}
			for (const id of targetOnly) if (target.side.removeSideCondition(id)) applied.add('TargetSideConditionRemoved');
			const ownField = target === user;
			const affected = ownField ? [user.side, ...user.side.foeSidesWithConditions()] : [target.side, user.side];
			for (const side of new Set(affected)) {
				for (const id of both) {
					if (!side.removeSideCondition(id)) continue;
					const name = battle.dex.conditions.get(id).name;
					if (ownField) battle.add('-sideend', side, name);
					else battle.add('-sideend', side, name, `[from] move: ${move.name}`, `[of] ${user}`);
					applied.add('BothSidesConditionRemoved');
				}
			}
			if (terrain) battle.field.clearTerrain();
			const succeeded = [...triggers].some(trigger => applied.has(trigger));
			if (ownField && succeeded) battle.add('-activate', user, `move: ${move.name}`);
			return succeeded;
		};
	}
	case 'RemoveVolatile': {
		keys('ConditionId');
		const condition = string(effect.ConditionId, `${path}.ConditionId`);
		return (_battle, target) => target.removeVolatile(condition);
	}
	case 'RemoveSideConditions': {
		keys('Conditions');
		const conditions = strings(effect.Conditions, `${path}.Conditions`);
		return (_battle, target, _user, move) => {
			let removed = false;
			for (const condition of conditions) {
				if (!target.side.removeSideCondition(condition)) continue;
				removed = true;
				target.battle.add('-sideend', target.side, target.battle.dex.conditions.get(condition).name, `[from] move: ${move.name}`);
			}
			return removed;
		};
	}
	case 'RemoveHeldItem':
		keys();
		return (battle, target, user, move) => {
			const item = target.takeItem();
			if (!item) return false;
			battle.add('-enditem', target, item.name, `[from] move: ${move.name}`, `[of] ${user}`);
			return true;
		};
	case 'EatTargetBerry':
	case 'TransferHeldItem': {
		const transfer = effect.Type === 'TransferHeldItem';
		if (transfer) {
			keys('From', 'To', 'Mode', 'ItemKind');
			choice(effect.From, ['Target'], `${path}.From`);
			choice(effect.To, ['User'], `${path}.To`);
			const mode = choice(effect.Mode, ['Consume', 'Equip'], `${path}.Mode`);
			if (mode === 'Equip') {
				if ('ItemKind' in effect) invalid(`${path}.ItemKind`, 'item filtering is available for consumption');
				return eventEffect({ Type: 'StealHeldItem', RequireEmptyUserItemSlot: true, BlockedByUserVolatile: 'gem',
					RestoreItemOnFailure: true }, path);
			}
			choice(effect.ItemKind, ['Berry'], `${path}.ItemKind`);
		} else {
			keys('RequiresLivingUser', 'TriggerEatItemEvent', 'ExternalStalenessItemId');
		}
		const alive = transfer || bool(effect.RequiresLivingUser, `${path}.RequiresLivingUser`);
		const event = transfer || bool(effect.TriggerEatItemEvent, `${path}.TriggerEatItemEvent`);
		const staleness = transfer ? 'leppaberry' : string(effect.ExternalStalenessItemId, `${path}.ExternalStalenessItemId`);
		return (battle, target, user, move) => {
			const item = target.getItem();
			if ((alive && !user.hp) || !item.isBerry || !target.takeItem(user)) return false;
			battle.add('-enditem', target, item.name, '[from] stealeat', `[move] ${move.name}`, `[of] ${user}`);
			if (event && battle.singleEvent('Eat', item, target.itemState, user, user, move)) {
				battle.runEvent('EatItem', user, user, move, item);
				if (item.id === staleness) target.staleness = 'external';
			}
			if (item.onEat) user.ateBerry = true;
			return true;
		};
	}
	case 'DestroyHeldItem': {
		keys('ItemKinds');
		const kinds = new Set(strings(effect.ItemKinds, `${path}.ItemKinds`));
		for (const item of kinds) choice(item, ['Berry', 'Gem'], `${path}.ItemKinds`);
		return (battle, target, user, move) => {
			const item = target.getItem();
			if (!((item.isBerry && kinds.has('Berry')) || (item.isGem && kinds.has('Gem'))) || !target.takeItem(user)) return false;
			battle.add('-enditem', target, item.name, `[from] move: ${move.name}`, `[of] ${user}`);
			return true;
		};
	}
	case 'RevealHeldItem':
		keys();
		return (battle, target, _user, move) => {
			if (!target.item) return false;
			battle.add('-activate', target, `move: ${move.name}`, target.getItem().name);
			return true;
		};
	case 'StealHeldItem': {
		keys('RequireEmptyUserItemSlot', 'BlockedByUserVolatile', 'RestoreItemOnFailure');
		const empty = bool(effect.RequireEmptyUserItemSlot, `${path}.RequireEmptyUserItemSlot`);
		const blocked = string(effect.BlockedByUserVolatile, `${path}.BlockedByUserVolatile`);
		const restore = bool(effect.RestoreItemOnFailure, `${path}.RestoreItemOnFailure`);
		return (battle, target, user, move) => {
			if ((empty && user.item) || user.volatiles[blocked]) return false;
			const item = target.takeItem(user);
			if (!item) return false;
			if (!battle.singleEvent('TakeItem', item, target.itemState, user, target, move, item) || !user.setItem(item)) {
				if (restore) target.item = item.id;
				return false;
			}
			battle.add('-enditem', target, item, '[silent]', `[from] move: ${move.name}`, `[of] ${user}`);
			battle.add('-item', user, item, `[from] move: ${move.name}`, `[of] ${target}`);
			return true;
		};
	}
	case 'RestoreLastHeldItem': {
		keys('RequiresEmptyHeldItemSlot', 'ClearStoredItem');
		const empty = bool(effect.RequiresEmptyHeldItemSlot, `${path}.RequiresEmptyHeldItemSlot`);
		const clear = bool(effect.ClearStoredItem, `${path}.ClearStoredItem`);
		return (battle, pokemon, user, move) => {
			if ((empty && pokemon.item) || !pokemon.lastItem) return false;
			const id = pokemon.lastItem;
			if (clear) pokemon.lastItem = '' as ID;
			battle.add('-item', pokemon, battle.dex.items.get(id), `[from] move: ${move.name}`);
			return pokemon.setItem(id, user, move);
		};
	}
	case 'AverageCurrentHP': {
		keys('TargetHPSource', 'Rounding', 'MinimumHP');
		const hp = choice(effect.TargetHPSource, ['Current', 'Undynamaxed'], `${path}.TargetHPSource`);
		choice(effect.Rounding, ['Floor'], `${path}.Rounding`);
		const min = integer(effect.MinimumHP, `${path}.MinimumHP`, 1);
		return (battle, target, user, move) => {
			const current = hp === 'Undynamaxed' ? target.getUndynamaxedHP() : target.hp;
			const average = Math.max(min, Math.floor((current + user.hp) / 2));
			target.sethp(target.hp - (current - average));
			battle.add('-sethp', target, target.getHealth, `[from] move: ${move.name}`, '[silent]');
			user.sethp(average);
			battle.add('-sethp', user, user.getHealth, `[from] move: ${move.name}`);
			return true;
		};
	}
	case 'BoostByVolatileSourceForm': {
		keys('ConditionId', 'RequiredBaseSpeciesId', 'DefaultEffect', 'Overrides');
		const condition = string(effect.ConditionId, `${path}.ConditionId`);
		const species = string(effect.RequiredBaseSpeciesId, `${path}.RequiredBaseSpeciesId`);
		const fallback = eventEffect(effect.DefaultEffect, `${path}.DefaultEffect`);
		const choices = new Map<string, EffectAction>();
		for (const [index, value] of list(effect.Overrides, `${path}.Overrides`).entries()) {
			const location = `${path}.Overrides[${index}]`;
			const entry = object(value, location, ['SpeciesId', 'Effect']);
			choices.set(string(entry.SpeciesId, `${location}.SpeciesId`), eventEffect(entry.Effect, `${location}.Effect`));
		}
		return (battle, target, user, move) => {
			const source = target.volatiles[condition]?.source;
			if (!source || toID(source.baseSpecies.baseSpecies) !== species) return false;
			return (choices.get(source.baseSpecies.id) ?? fallback)(battle, target, user, move);
		};
	}
	case 'ToggleSpeciesForm': {
		keys('RequiredBaseSpeciesId', 'Forms', 'BlockIfTransformed');
		const species = string(effect.RequiredBaseSpeciesId, `${path}.RequiredBaseSpeciesId`);
		const forms = strings(effect.Forms, `${path}.Forms`);
		if (forms.length !== 2) invalid(`${path}.Forms`, 'expected exactly two forms');
		const transformed = bool(effect.BlockIfTransformed, `${path}.BlockIfTransformed`);
		return (_battle, target, _user, move) => {
			if (toID(target.baseSpecies.baseSpecies) !== species || (transformed && target.transformed)) return false;
			const next = target.species.id === forms[1] ? forms[0] : forms[1];
			return !!target.formeChange(next, move, false, '0', '[msg]');
		};
	}
	case 'SwapStoredStats': {
		keys('Stats');
		const selected = list(effect.Stats, `${path}.Stats`).map(stat => lookup(stat, stats, `${path}.Stats`));
		return (battle, target, user, move) => {
			for (const stat of selected) {
				[user.storedStats[stat], target.storedStats[stat]] = [target.storedStats[stat], user.storedStats[stat]];
			}
			battle.add('-activate', user, `move: ${move.name}`, `[of] ${target}`);
			return true;
		};
	}
	case 'CopyStatStages': {
		keys('CopyVolatiles');
		const ids = effect.CopyVolatiles === undefined ? [] : strings(effect.CopyVolatiles, `${path}.CopyVolatiles`);
		return (battle, target, user, move) => {
			user.setBoost(target.boosts);
			for (const id of ids) user.removeVolatile(id);
			for (const id of ids) {
				const original = target.volatiles[id];
				if (!original || !user.addVolatile(id)) continue;
				const copied = user.volatiles[id];
				if (id === 'gmaxchistrike') copied.layers = original.layers;
				if (id === 'dragoncheer') copied.hasDragonType = original.hasDragonType;
			}
			battle.add('-copyboost', user, target, `[from] move: ${move.name}`);
			return true;
		};
	}
	case 'CopyTargetTypes': {
		keys('BlockedUserBaseSpecies', 'BlockIfUserTerastallized', 'CopyAddedType', 'FallbackBaseType', 'PreserveApparentTypeIfUnknown');
		const blocked = strings(effect.BlockedUserBaseSpecies, `${path}.BlockedUserBaseSpecies`);
		const blockTera = bool(effect.BlockIfUserTerastallized, `${path}.BlockIfUserTerastallized`);
		const added = bool(effect.CopyAddedType, `${path}.CopyAddedType`);
		const fallback = string(effect.FallbackBaseType, `${path}.FallbackBaseType`);
		const preserve = bool(effect.PreserveApparentTypeIfUnknown, `${path}.PreserveApparentTypeIfUnknown`);
		return (battle, target, user, move) => {
			if (blocked.includes(toID(user.species.baseSpecies)) || (blockTera && user.terastallized)) return false;
			const types = target.getTypes(true).filter(type => type !== '???');
			if (!types.length) {
				if (!target.addedType) return false;
				types.push(fallback);
			}
			const previous = user.apparentType;
			battle.add('-start', user, 'typechange', `[from] move: ${move.name}`, `[of] ${target}`);
			user.setType(types);
			if (added) user.addedType = target.addedType;
			user.knownType = target.isAlly(user) && target.knownType;
			if (!user.knownType && preserve) user.apparentType = previous;
			return true;
		};
	}
	case 'ReplaceCurrentMoveWithTargetLastMove': {
		keys('BlockIfTransformed', 'ExcludeKnownMoves', 'ExcludeZMoves', 'ExcludeMaxMoves', 'ExcludedFlags',
			'UseCopiedMovePP', 'VirtualSlot', 'UpdateBaseSlot');
		const transformed = bool(effect.BlockIfTransformed, `${path}.BlockIfTransformed`);
		const known = bool(effect.ExcludeKnownMoves, `${path}.ExcludeKnownMoves`);
		const z = bool(effect.ExcludeZMoves, `${path}.ExcludeZMoves`);
		const max = bool(effect.ExcludeMaxMoves, `${path}.ExcludeMaxMoves`);
		const flags = strings(effect.ExcludedFlags, `${path}.ExcludedFlags`);
		nativeBoolean(effect.UseCopiedMovePP, `${path}.UseCopiedMovePP`, true);
		const virtual = effect.VirtualSlot === undefined ? false : bool(effect.VirtualSlot, `${path}.VirtualSlot`);
		const base = effect.UpdateBaseSlot === undefined ? false : bool(effect.UpdateBaseSlot, `${path}.UpdateBaseSlot`);
		return (battle, target, user, current) => {
			const previous = target.lastMove;
			if (!previous || (transformed && user.transformed) || (known && user.moves.includes(previous.id)) ||
				(z && previous.isZ) || (max && previous.isMax) || flags.some(flag => previous.flags[flag as keyof typeof previous.flags])) return false;
			const index = user.moves.indexOf(current.id);
			if (index < 0) return false;
			const slot = { move: previous.name, id: previous.id, pp: previous.pp, maxpp: previous.pp,
				target: previous.target, disabled: false, used: false, ...(virtual && { virtual: true }) };
			user.moveSlots[index] = slot;
			if (base) user.baseMoveSlots[index] = slot;
			if (virtual) battle.add('-start', user, 'Mimic', previous.name);
			else battle.add('-activate', user, `move: ${current.name}`, previous.name);
			return true;
		};
	}
	case 'InvertStatStages':
		keys();
		return (battle, target) => {
			let changed = false;
			for (const stat of stages.values()) {
				if (!target.boosts[stat]) continue;
				target.boosts[stat] = -target.boosts[stat];
				changed = true;
			}
			if (changed) battle.add('-invertboost', target);
			return changed;
		};
	case 'DamageByMaxHPFraction': {
		keys('HPBasis', 'Fraction');
		const hp = choice(effect.HPBasis, ['BaseMaxHP', 'MaxHP'], `${path}.HPBasis`);
		const [n, d] = fraction(effect.Fraction, `${path}.Fraction`);
		return (battle, target, user, move) => !!battle.damage(
			(hp === 'BaseMaxHP' ? target.baseMaxhp : target.maxhp) * n / d, target, user, battle.dex.conditions.get(move.id)
		);
	}
	case 'SwapHeldItems': {
		keys('CheckBothCanGiveAndReceive', 'FailIfBothEmpty');
		const check = bool(effect.CheckBothCanGiveAndReceive, `${path}.CheckBothCanGiveAndReceive`);
		const requireItem = bool(effect.FailIfBothEmpty, `${path}.FailIfBothEmpty`);
		return (battle, target, user, move) => {
			const theirs = target.takeItem(user);
			const ours = user.takeItem();
			const restore = () => {
				if (theirs) target.item = theirs.id;
				if (ours) user.item = ours.id;
				return false;
			};
			if (theirs === false || ours === false) return restore();
			if (!theirs && !ours) return !requireItem;
			if (check && ((ours && !battle.singleEvent('TakeItem', ours, user.itemState, target, user, move, ours)) ||
				(theirs && !battle.singleEvent('TakeItem', theirs, target.itemState, user, target, move, theirs)))) return restore();
			battle.add('-activate', user, 'move: Trick', `[of] ${target}`);
			if (ours) {
				target.setItem(ours);
				battle.add('-item', target, ours, `[from] move: ${move.name}`);
			} else {
				battle.add('-enditem', target, theirs, '[silent]', `[from] move: ${move.name}`);
			}
			if (theirs) {
				user.setItem(theirs);
				battle.add('-item', user, theirs, `[from] move: ${move.name}`);
			} else {
				battle.add('-enditem', user, ours, '[silent]', `[from] move: ${move.name}`);
			}
			return true;
		};
	}
	case 'SwapStatStages': {
		keys('Stats');
		const names = list(effect.Stats, `${path}.Stats`).map((stat, index) =>
			lookup(stat, stages, `${path}.Stats[${index}]`));
		return (battle, target, user, move) => {
			const userStages: SparseBoostsTable = {};
			const targetStages: SparseBoostsTable = {};
			for (const name of names) {
				userStages[name] = target.boosts[name];
				targetStages[name] = user.boosts[name];
			}
			user.setBoost(userStages);
			target.setBoost(targetStages);
			const source = `[from] move: ${move.name}`;
			if (names.length === stages.size) battle.add('-swapboost', user, target, source);
			else battle.add('-swapboost', user, target, names.join(', '), source);
			return true;
		};
	}
	case 'AverageStoredStats': {
		keys('Stats');
		const names = list(effect.Stats, `${path}.Stats`).map((stat, index) =>
			lookup(stat, stats, `${path}.Stats[${index}]`));
		return (battle, target, user, move) => {
			for (const name of names) {
				const average = Math.floor((user.storedStats[name] + target.storedStats[name]) / 2);
				user.storedStats[name] = average;
				target.storedStats[name] = average;
			}
			battle.add('-activate', user, `move: ${move.name}`, `[of] ${target}`);
			return true;
		};
	}
	case 'SwapAbilities':
		keys();
		return (battle, target, user) => {
			const result = battle.skillSwap(user, target);
			return result === undefined || !!result;
		};
	case 'TransformIntoTarget':
		keys();
		return (_battle, target, user) => user.transformInto(target);
	case 'TrapWhileUserIsActive':
		keys();
		return (_battle, target, user, move) => user.isActive && !!target.addVolatile('trapped', user, move, 'trapper');
	case 'MutualTrap': {
		keys('ConditionId');
		const trap = choice(effect.ConditionId, ['trapped'], `${path}.ConditionId`);
		return (_battle, target, user, move) => {
			const userTrapped = user.addVolatile(trap, target, move, 'trapper');
			const targetTrapped = target.addVolatile(trap, user, move, 'trapper');
			return !!(userTrapped || targetTrapped);
		};
	}
	case 'TrapUser': {
		keys('ConditionId', 'TrapId');
		const condition = choice(effect.ConditionId, ['noretreat'], `${path}.ConditionId`);
		choice(effect.TrapId, ['trapped'], `${path}.TrapId`);
		return (_battle, target, user, move) => !!target.addVolatile(condition, user, move);
	}
	case 'EmitMoveEvent': {
		keys('Event', 'AnimationVariant');
		const event = choice(effect.Event, ['Activate', 'Nothing'], `${path}.Event`);
		const animation = effect.AnimationVariant === undefined ? undefined :
			choice(effect.AnimationVariant, ['AllOut'], `${path}.AnimationVariant`);
		return (battle, target, _user, move) => {
			if (animation) battle.attrLastMove(`[anim] ${move.name} All Out`);
			if (event === 'Nothing') battle.add('-nothing');
			else battle.add('-activate', target, `move: ${move.name}`);
			return true;
		};
	}
	default:
		const native = nativeCondition(effect, path);
		if (native?.volatileStatus) return (_battle, target, user, move) => !!target.addVolatile(native.volatileStatus!, user, move);
		if (native?.sideCondition) return (_battle, target, user, move) => target.side.addSideCondition(native.sideCondition!, user, move);
		if (native?.pseudoWeather) return (battle, _target, user, move) => battle.field.addPseudoWeather(native.pseudoWeather!, user, move);
		return invalid(`${path}.Type`, `unsupported event effect ${String(effect.Type)}`);
	}
}

function attachEffect(move: MoveData, fields: Fields, path: string) {
	const data = object(fields.Effect, `${path}.Effect`);
	if (data.Type === 'ScheduleSlotDamage') {
		attachFutureAttack(move, fields, data, path);
		return;
	}
	if (fields.FinishMoveOnSuccess !== undefined) {
		object(fields, path, ['Type', 'ApplyAt', 'Recipient', 'Effect', 'Requirements', 'StopOnFailure', 'FinishMoveOnSuccess']);
		nativeBoolean(fields.FinishMoveOnSuccess, `${path}.FinishMoveOnSuccess`, true);
		choice(fields.ApplyAt, ['TryHit'], `${path}.ApplyAt`);
		choice(fields.Recipient, data.Type === 'CallMoveByTerrain' ? ['User'] : ['Target'], `${path}.Recipient`);
		if (data.Type !== 'CallTargetLastMove' && data.Type !== 'CallMoveByTerrain') {
			invalid(`${path}.Effect.Type`, 'unsupported effect for finishing a move');
		}
		if (move.onTryHit) invalid(path, 'already has a hit requirement');
		const call = eventEffect(data, `${path}.Effect`);
		const applies = requirements(fields.Requirements, `${path}.Requirements`);
		const stop = fields.StopOnFailure !== undefined && bool(fields.StopOnFailure, `${path}.StopOnFailure`);
		move.callsMove = true;
		move.onTryHit = function (target, user, activeMove) {
			if (!applies(this, user, target, activeMove)) return;
			if (call(this, target, user, activeMove)) return null;
			if (stop) return false;
		};
		return;
	}
	object(fields, path, ['Type', 'ApplyAt', 'Recipient', 'Effect', 'Requirements', 'StopOnFailure']);
	const at = choice(fields.ApplyAt, ['TryHit', 'Hit', 'HitField', 'HitSide', 'AfterHit', 'AfterSubDamage',
		'AfterMoveSecondarySelf', 'AfterMove'], `${path}.ApplyAt`);
	const recipient = choice(fields.Recipient, ['User', 'Target'], `${path}.Recipient`);
	const stop = fields.StopOnFailure === undefined ? false : bool(fields.StopOnFailure, `${path}.StopOnFailure`);
	if (stop && at !== 'TryHit' && at !== 'Hit' && at !== 'HitField' && at !== 'HitSide') {
		invalid(`${path}.StopOnFailure`, 'this event cannot stop an action');
	}
	if ((at === 'HitField' || at === 'HitSide') && recipient !== 'User') {
		invalid(`${path}.Recipient`, 'select the user when handling a field or side');
	}
	const applies = requirements(fields.Requirements, `${path}.Requirements`);
	const effect = eventEffect(fields.Effect, `${path}.Effect`);
	const run = (battle: Battle, target: Pokemon, user: Pokemon, activeMove: ActiveMove) => {
		if (!applies(battle, user, target, activeMove)) return;
		const subject = recipient === 'User' ? user : target;
		if (!subject) return;
		if (!effect(battle, subject, user, activeMove) && stop) return false;
	};
	switch (at) {
	case 'HitField': {
		if (move.onHitField) invalid(path, 'already has a field effect');
		const group = object(fields.Effect, `${path}.Effect`).Type === 'ForEachPokemon';
		const eater = group && object(object(fields.Effect, `${path}.Effect`).Effect, `${path}.Effect.Effect`).Type === 'EatHeldBerry';
		move.onHitField = function (target, user, activeMove) {
			if (!applies(this, user, target, activeMove)) return;
			const success = effect(this, user, user, activeMove);
			if (!success && eater) {
				this.add('-fail', user, `move: ${activeMove.name}`);
				this.attrLastMove('[still]');
				return this.NOT_FAIL;
			}
			if (!success && (stop || group)) return false;
		};
		break;
	}
	case 'HitSide':
		if (move.onHitSide) invalid(path, 'already has a side effect');
		move.onHitSide = function (_side, user, activeMove) {
			if (applies(this, user, user, activeMove) && !effect(this, user, user, activeMove) && stop) return false;
		};
		break;
	case 'TryHit': {
		const previous = move.onTryHit;
		move.onTryHit = function (target, user, activeMove) {
			const result = typeof previous === 'function' ? previous.call(this, target, user, activeMove) : previous;
			return result === false || result === null || result === '' ? result : run(this, target, user, activeMove) ?? result;
		};
		break;
	}
	case 'Hit': {
		const previous = move.onHit;
		move.onHit = function (target, user, activeMove) {
			const result = typeof previous === 'function' ? previous.call(this, target, user, activeMove) : previous;
			return result === false || result === null || result === '' ? result : run(this, target, user, activeMove) ?? result;
		};
		break;
	}
	case 'AfterSubDamage': {
		const previous = move.onAfterSubDamage;
		move.onAfterSubDamage = function (damage, target, user, activeMove) {
			previous?.call(this, damage, target, user, activeMove);
			run(this, target, user, activeMove);
		};
		break;
	}
	case 'AfterHit': {
		const previous = move.onAfterHit;
		move.onAfterHit = function (target, user, activeMove) {
			previous?.call(this, target, user, activeMove);
			run(this, target, user, activeMove);
		};
		break;
	}
	case 'AfterMove':
	case 'AfterMoveSecondarySelf': {
		const key = at === 'AfterMove' ? 'onAfterMove' : 'onAfterMoveSecondarySelf';
		const previous = move[key];
		move[key] = function (user, target, activeMove) {
			previous?.call(this, user, target, activeMove);
			run(this, target, user, activeMove);
		};
		break;
	}
	}
}

function attachFutureAttack(move: MoveData, fields: Fields, effect: Fields, path: string) {
	object(fields, path, ['Type', 'ApplyAt', 'Recipient', 'Effect', 'StopOnFailure', 'FinishMoveOnSuccess']);
	choice(fields.ApplyAt, ['TryMove'], `${path}.ApplyAt`);
	choice(fields.Recipient, ['Target'], `${path}.Recipient`);
	nativeBoolean(fields.StopOnFailure, `${path}.StopOnFailure`, true);
	nativeBoolean(fields.FinishMoveOnSuccess, `${path}.FinishMoveOnSuccess`, true);
	const location = `${path}.Effect`;
	object(effect, location, ['Type', 'ConditionId', 'ResidualOrder', 'IgnoreUserOccupyingTargetSlot',
		'SnapshotMove', 'CheckTypeImmunityOnResolution']);
	const condition = choice(effect.ConditionId, ['futuremove'], `${location}.ConditionId`);
	integer(effect.ResidualOrder, `${location}.ResidualOrder`, 3, 3);
	nativeBoolean(effect.IgnoreUserOccupyingTargetSlot, `${location}.IgnoreUserOccupyingTargetSlot`, true);
	const snapshot = bool(effect.SnapshotMove, `${location}.SnapshotMove`);
	const checkImmunity = effect.CheckTypeImmunityOnResolution === undefined ? undefined :
		bool(effect.CheckTypeImmunityOnResolution, `${location}.CheckTypeImmunityOnResolution`);
	if (move.onTry) invalid(path, 'already has an attempt handler');
	move.onTry = function (user, target, activeMove) {
		if (!target || !target.side.addSlotCondition(target, condition)) return false;
		const data = snapshot ? activeMove : this.dex.moves.get(activeMove.id);
		const moveData = {
			id: activeMove.id, name: activeMove.name, accuracy: data.accuracy, basePower: data.basePower,
			category: data.category, priority: data.priority, flags: { ...data.flags }, type: data.type,
			effectType: 'Move',
			...(checkImmunity === undefined ? {} : { ignoreImmunity: !checkImmunity }),
		};
		Object.assign(target.side.slotConditions[target.position][condition], { move: activeMove.id, source: user, moveData });
		this.add('-start', user, snapshot && checkImmunity === undefined ? activeMove.name : `move: ${activeMove.name}`);
		return this.NOT_FAIL;
	};
}

function protectionCondition(fields: Fields, path: string): string {
	const contactStatus = new Map([['banefulbunker', 'Poison'], ['burningbulwark', 'Burn']]);
	const statChanges = new Map([['kingsshield', ['Attack', -1] as const],
		['obstruct', ['Defense', -2] as const], ['silktrap', ['Speed', -1] as const]]);
	const id = choice(fields.ConditionId, ['protect', 'endure', 'spikyshield', ...contactStatus.keys(), ...statChanges.keys()], `${path}.ConditionId`);
	integer(fields.DurationTurns, `${path}.DurationTurns`, 1, 1);
	const status = contactStatus.get(id);
	const stat = statChanges.get(id);
	const contact = id !== 'protect' && id !== 'endure';
	if (contact || 'OnContact' in fields) {
		if (!contact) invalid(`${path}.OnContact`, 'the selected condition has no contact effect');
		const hit = object(fields.OnContact, `${path}.OnContact`);
		if (status) {
			object(hit, `${path}.OnContact`, ['Type', 'Status']);
			choice(hit.Type, ['ApplyStatus'], `${path}.OnContact.Type`);
			choice(hit.Status, [status], `${path}.OnContact.Status`);
		} else if (stat) {
			object(hit, `${path}.OnContact`, ['Type', 'Stages']);
			choice(hit.Type, ['ChangeStats'], `${path}.OnContact.Type`);
			const changes = object(hit.Stages, `${path}.OnContact.Stages`, [stat[0]]);
			integer(changes[stat[0]], `${path}.OnContact.Stages.${stat[0]}`, stat[1], stat[1]);
		} else {
			object(hit, `${path}.OnContact`, ['Type', 'HPBasis', 'Fraction']);
			choice(hit.Type, ['DamageByMaxHPFraction'], `${path}.OnContact.Type`);
			choice(hit.HPBasis, ['BaseMaxHP'], `${path}.OnContact.HPBasis`);
			nativeFraction(hit.Fraction, `${path}.OnContact.Fraction`, 1, 8);
		}
		nativeBoolean(fields.TriggerOnZOrMaxContact, `${path}.TriggerOnZOrMaxContact`, true);
	} else if ('TriggerOnZOrMaxContact' in fields) {
		nativeBoolean(fields.TriggerOnZOrMaxContact, `${path}.TriggerOnZOrMaxContact`, false);
	}
	if (id === 'burningbulwark' || 'BlockedMoveCategories' in fields) {
		const categories = new Set(strings(fields.BlockedMoveCategories, `${path}.BlockedMoveCategories`));
		const onlyDamage = id === 'burningbulwark' || !!stat;
		if (!categories.has('Physical') || !categories.has('Special') ||
			categories.has('Status') === onlyDamage || categories.size !== (onlyDamage ? 2 : 3)) {
			invalid(`${path}.BlockedMoveCategories`, 'categories do not match the selected native condition');
		}
	}
	if (id === 'endure') {
		const survival = object(fields.Survival, `${path}.Survival`, ['MinimumHP', 'Priority', 'DamageFromMovesOnly']);
		integer(survival.MinimumHP, `${path}.Survival.MinimumHP`, 1, 1);
		integer(survival.Priority, `${path}.Survival.Priority`, -10, -10);
		nativeBoolean(survival.DamageFromMovesOnly, `${path}.Survival.DamageFromMovesOnly`, true);
	} else if ('Survival' in fields) {
		invalid(`${path}.Survival`, 'expected the endure condition');
	}
	if ('ResetLockedMoveAtTwoTurns' in fields) {
		nativeBoolean(fields.ResetLockedMoveAtTwoTurns, `${path}.ResetLockedMoveAtTwoTurns`, id === 'protect' ||
			id === 'spikyshield' || !!stat);
	}
	return id;
}

function semiInvulnerableCondition(mode: string, fields: Fields, path: string, moveName: string): string {
	const location = `${path}.IncomingMoves`;
	const incoming = object(fields.IncomingMoves, location, ['Default', 'AllowedMoveIds', 'Modifiers']);
	choice(incoming.Default, ['Avoid'], `${location}.Default`);
	if (mode === 'SemiInvulnerable') {
		if (incoming.AllowedMoveIds !== undefined) nativeOptions(incoming.AllowedMoveIds, `${location}.AllowedMoveIds`, []);
		if (incoming.Modifiers !== undefined && list(incoming.Modifiers, `${location}.Modifiers`).length) {
			invalid(`${location}.Modifiers`, 'the selected condition has no incoming move modifiers');
		}
		return toID(moveName).endsWith('shadowforce') ? 'shadowforce' : 'phantomforce';
	}
	const airborne = mode === 'Airborne';
	const allowed = airborne ? ['gust', 'twister', 'skyuppercut', 'thunder', 'hurricane', 'smackdown', 'thousandarrows'] :
		mode === 'Underground' ? ['earthquake', 'magnitude'] : ['surf', 'whirlpool'];
	nativeOptions(incoming.AllowedMoveIds, `${location}.AllowedMoveIds`, allowed);
	const modifiers = list(incoming.Modifiers, `${location}.Modifiers`);
	if (modifiers.length !== 1) invalid(`${location}.Modifiers`, 'expected one incoming modifier');
	const modifier = object(modifiers[0], `${location}.Modifiers[0]`, ['ApplyAt', 'MoveIds', 'Multiplier']);
	const timing = choice(modifier.ApplyAt, airborne ? ['ModifyIncomingBasePower', 'ModifyIncomingDamage'] : ['ModifyIncomingDamage'],
		`${location}.Modifiers[0].ApplyAt`);
	nativeOptions(modifier.MoveIds, `${location}.Modifiers[0].MoveIds`, airborne ? ['gust', 'twister'] : allowed);
	integer(modifier.Multiplier, `${location}.Modifiers[0].Multiplier`, 2, 2);
	if (!airborne || fields.ResidualImmunities !== undefined) {
		nativeOptions(fields.ResidualImmunities, `${path}.ResidualImmunities`, airborne ? [] : ['sandstorm', 'hail']);
	}
	return airborne ? timing === 'ModifyIncomingBasePower' ? 'bounce' : 'fly' : mode === 'Underground' ? 'dig' : 'dive';
}

function attachRetaliation(move: MoveData, fields: Fields, path: string) {
	const field = (key: string) => `${path}.${key}`;
	const modern = fields.Type === 'RetaliateLastDamage';
	object(fields, path, modern ?
		['Type', 'ConditionId', 'DamageCategory', 'FoesOnly', 'Multiplier', 'MinimumDamage', 'RequireThisTurn',
			'RedirectToAttackerSlot', 'RedirectPriority', 'TrackBeforeTurn', 'CanBeCopied'] :
		['Type', 'Tracking', 'Multiplier', 'MinimumDamage', 'Target', 'FoeOnly', 'Category',
			'TrackFrom', 'DurationTurns', 'RedirectPriority', 'CanBeCopied']);
	const track = modern ? fields.TrackBeforeTurn !== undefined && bool(fields.TrackBeforeTurn, field('TrackBeforeTurn')) :
		choice(fields.Tracking, ['LastRecordedDamageThisTurn', 'LastDamagingHitAfterSelection'], field('Tracking')) === 'LastDamagingHitAfterSelection';
	const ratio = modern ? numeric(fields.Multiplier, field('Multiplier')) : (() => {
		const multiplier = object(fields.Multiplier, field('Multiplier'), ['Numerator', 'Denominator']);
		return integer(multiplier.Numerator, field('Multiplier.Numerator')) /
			integer(multiplier.Denominator, field('Multiplier.Denominator'), 1);
	})();
	const minimum = integer(fields.MinimumDamage, field('MinimumDamage'), 1);
	const foeKey = modern ? 'FoesOnly' : 'FoeOnly';
	const foe = fields[foeKey] === undefined ? true : bool(fields[foeKey], field(foeKey));
	if (modern) {
		nativeBoolean(fields.RequireThisTurn, field('RequireThisTurn'), true);
		nativeBoolean(fields.RedirectToAttackerSlot, field('RedirectToAttackerSlot'), true);
	} else {
		choice(fields.Target, ['AttackerSlot'], field('Target'));
	}
	if (move.damageCallback || move.onTry || move.onModifyTarget || move.condition || move.beforeTurnCallback) {
		invalid(path, 'retaliation conflicts with another move handler');
	}
	if (!track) {
		for (const key of ['ConditionId', 'DamageCategory', 'Category', 'DurationTurns', 'TrackFrom', 'RedirectPriority', 'CanBeCopied']) {
			if (key in fields) invalid(field(key), 'expected damage tracking before the turn');
		}
		move.onTry = function (user) { if (!user.getLastDamagedBy(foe)?.thisTurn) return false; };
		move.onModifyTarget = function (relay, user) {
			const attack = user.getLastDamagedBy(foe);
			if (attack) relay.target = this.getAtSlot(attack.slot);
		};
		move.damageCallback = user => {
			const attack = user.getLastDamagedBy(foe);
			return attack ? Math.max(minimum, attack.damage * ratio) : 0;
		};
		return;
	}
	const category = choice(fields[modern ? 'DamageCategory' : 'Category'], ['Physical', 'Special'], field('Category'));
	if (!modern) choice(fields.TrackFrom, ['BeforeTurn'], field('TrackFrom'));
	const priority = integer(fields.RedirectPriority, field('RedirectPriority'), -Number.MAX_SAFE_INTEGER);
	const duration = modern ? 1 : integer(fields.DurationTurns, field('DurationTurns'), 1);
	const noCopy = !bool(fields.CanBeCopied, field('CanBeCopied'));
	if (modern) choice(fields.ConditionId, ['mirrorcoat'], field('ConditionId'));
	const id = toID(move.name);
	move.beforeTurnCallback = function (user) { user.addVolatile(id); };
	move.onTry = function (user) { if (!user.volatiles[id]?.slot) return false; };
	move.damageCallback = user => user.volatiles[id] ? Math.max(minimum, user.volatiles[id].damage ?? 0) : 0;
	move.condition = {
		duration,
		noCopy,
		onStart() {
			this.effectState.slot = null;
			this.effectState.damage = 0;
		},
		onRedirectTargetPriority: priority,
		onRedirectTarget(_target, user, _source, activeMove) {
			if (activeMove.id === id && user === this.effectState.target && this.effectState.slot) {
				return this.getAtSlot(this.effectState.slot);
			}
		},
		onDamagingHit(damage, target, attacker, hit) {
			if (this.getCategory(hit) === category && (!foe || !target.isAlly(attacker))) {
				this.effectState.slot = attacker.getSlot();
				this.effectState.damage = damage * ratio;
			}
		},
	};
}

function useMechanic(move: MoveData, value: unknown, path: string) {
	const fields = object(value, path);
	const field = (name: string) => `${path}.${name}`;
	const keys = (...names: string[]) => object(fields, path, ['Type', ...names]);
	const when = () => requirements(fields.Requirements, field('Requirements'));
	switch (fields.Type) {
	case 'SwapActivePositions': {
		keys('Destination', 'Requirements', 'ConsecutiveUsePenalty');
		choice(fields.Destination, ['OppositeEdge'], field('Destination'));
		const order = list(fields.Requirements, field('Requirements'));
		if (order.length !== 4) invalid(field('Requirements'), 'expected four position checks');
		const checks = [
			{ Type: 'GameTypeIn', GameTypes: ['doubles', 'triples'] },
			{ Type: 'IsAtEdge', Subject: 'User' },
			{ Type: 'HasActivePokemon', Slot: 'Destination' },
			{ Type: 'HasNotFainted', Subject: 'DestinationPokemon' },
		];
		for (const [index, check] of checks.entries()) {
			matchProfile(object(order[index], field(`Requirements[${index}]`)), check, field(`Requirements[${index}]`));
		}
		const penalty = object(fields.ConsecutiveUsePenalty, field('ConsecutiveUsePenalty'));
		matchProfile(penalty, { AppliesFromGeneration: 9, ApplyAt: 'PrepareHit', CounterScope: 'PerUserPerMove',
			DurationTurns: 2, ChanceNumerator: 1, InitialDenominator: 3, DenominatorMultiplier: 3,
			MaximumDenominator: 729, ResetOnFailedRoll: true }, field('ConsecutiveUsePenalty'));
		move.onPrepareHit = function (user) { if (this.gen >= 9) return user.addVolatile('allyswitch'); };
		move.onHit = function (user, _source, activeMove) {
			const slot = user.position === 0 ? user.side.active.length - 1 : 0;
			const other = user.side.active[slot];
			if ((this.gameType !== 'doubles' && this.gameType !== 'triples') ||
				user.side.active.length === 3 && user.position === 1 || !other || other.fainted) {
				this.add('-fail', user, `move: ${activeMove.name}`);
				this.attrLastMove('[still]');
				return this.NOT_FAIL;
			}
			this.swapPosition(user, slot, `[from] move: ${activeMove.name}`);
		};
		break;
	}
	case 'PartyMemberHits': {
		keys('PartyOrder', 'AlwaysIncludeUser', 'Requirements', 'PowerPerHit');
		nativeBoolean(fields.PartyOrder, field('PartyOrder'), true);
		const includeUser = bool(fields.AlwaysIncludeUser, field('AlwaysIncludeUser'));
		const checks = list(fields.Requirements, field('Requirements')).map((entry, index) => {
			const location = field(`Requirements[${index}]`);
			const rule = object(entry, location, ['Type', 'Subject']);
			choice(rule.Subject, ['PartyMember'], `${location}.Subject`);
			return choice(rule.Type, ['HasNotFainted', 'HasNoMajorStatus'], `${location}.Type`);
		});
		const power = object(fields.PowerPerHit, field('PowerPerHit'), ['BasePower', 'SpeciesBaseStat', 'SpeciesSource', 'Divisor', 'Rounding']);
		const base = integer(power.BasePower, field('PowerPerHit.BasePower'));
		const stat = lookup(power.SpeciesBaseStat, stats, field('PowerPerHit.SpeciesBaseStat'));
		const divisor = integer(power.Divisor, field('PowerPerHit.Divisor'), 1);
		choice(power.SpeciesSource, ['TeamSet'], field('PowerPerHit.SpeciesSource'));
		choice(power.Rounding, ['Floor'], field('PowerPerHit.Rounding'));
		move.onModifyMove = function (activeMove, user) {
			activeMove.allies = user.side.pokemon.filter(member => includeUser && member === user ||
				checks.every(check => check === 'HasNotFainted' ? !member.fainted : !member.status));
			activeMove.multihit = activeMove.allies.length;
		};
		move.basePowerCallback = function (_user, _target, activeMove) {
			const member = activeMove.allies?.shift();
			return member ? base + Math.floor(this.dex.species.get(member.set.species).baseStats[stat] / divisor) : 0;
		};
		break;
	}
	case 'FlingHeldItem': {
		keys('ApplyAt', 'ConditionId', 'ConsumeDuringUpdate', 'UseItemFlingData');
		choice(fields.ApplyAt, ['PrepareHit'], field('ApplyAt'));
		const condition = choice(fields.ConditionId, ['fling'], field('ConditionId'));
		nativeBoolean(fields.ConsumeDuringUpdate, field('ConsumeDuringUpdate'), true);
		nativeBoolean(fields.UseItemFlingData, field('UseItemFlingData'), true);
		move.onPrepareHit = function (_target, user, activeMove) {
			if (user.ignoringItem(true)) return false;
			const item = user.getItem();
			if (!this.singleEvent('TakeItem', item, user.itemState, user, user, activeMove, item) || !item.fling) return false;
			activeMove.basePower = item.fling.basePower;
			if (item.isBerry) {
				if (user.hasAbility('cudchew')) {
					this.singleEvent('EatItem', user.getAbility(), user.abilityState, user, user, activeMove, item);
				}
				activeMove.onHit = function (target) {
					if (this.singleEvent('Eat', item, user.itemState, target, user, activeMove)) {
						this.runEvent('EatItem', target, user, activeMove, item);
						if (item.id === 'leppaberry') target.staleness = 'external';
					}
					if (item.onEat) target.ateBerry = true;
				};
			} else if (item.fling.effect) {
				activeMove.onHit = item.fling.effect;
			} else if (item.fling.status || item.fling.volatileStatus) {
				(activeMove.secondaries ??= []).push(item.fling.status ? { status: item.fling.status } :
					{ volatileStatus: item.fling.volatileStatus });
			}
			user.addVolatile(condition);
		};
		break;
	}
	case 'LinkFaintToAttacker': {
		keys('ConditionId', 'CanBeCopied', 'CancelOnRepeat', 'EndsBeforeNextMove', 'BeforeMovePriority',
			'EndsOnMoveAborted', 'FoeOnly', 'DamageFromMovesOnly', 'ExcludedFlags', 'ImmuneAttackerVolatiles');
		choice(fields.ConditionId, ['destinybond'], field('ConditionId'));
		const copy = bool(fields.CanBeCopied, field('CanBeCopied'));
		const repeat = bool(fields.CancelOnRepeat, field('CancelOnRepeat'));
		const before = bool(fields.EndsBeforeNextMove, field('EndsBeforeNextMove'));
		const priority = integer(fields.BeforeMovePriority, field('BeforeMovePriority'), -Number.MAX_SAFE_INTEGER);
		const abort = bool(fields.EndsOnMoveAborted, field('EndsOnMoveAborted'));
		const foe = bool(fields.FoeOnly, field('FoeOnly'));
		const movesOnly = bool(fields.DamageFromMovesOnly, field('DamageFromMovesOnly'));
		const flags = strings(fields.ExcludedFlags, field('ExcludedFlags'));
		const immune = strings(fields.ImmuneAttackerVolatiles, field('ImmuneAttackerVolatiles'));
		const id = toID(move.name);
		const label = 'Destiny Bond';
		move.volatileStatus = id;
		move.onPrepareHit = user => !repeat || !user.removeVolatile(id);
		move.condition = {
			noCopy: !copy,
			onStart(user) { this.add('-singlemove', user, label); },
			onFaint(target, attacker, effect) {
				if (!attacker?.hp || !effect || (foe && target.isAlly(attacker))) return;
				if (effect.effectType === 'Move') {
					if (flags.some(flag => effect.flags[flag as keyof typeof effect.flags])) return;
				} else if (movesOnly) {
					return;
				}
				if (immune.some(key => attacker.volatiles[key])) {
					if (attacker.volatiles.dynamax) this.add('-hint', 'Dynamaxed Pokémon are immune to Destiny Bond.');
					return;
				}
				this.add('-activate', target, `move: ${label}`);
				attacker.faint();
			},
			onBeforeMovePriority: priority,
			onBeforeMove(user, _target, used) { if (before && used.id !== id) user.removeVolatile(id); },
			onMoveAborted(user) { if (abort) user.removeVolatile(id); },
		};
		break;
	}
	case 'StoreDamageThenStrike': {
		keys('ConditionId', 'DurationTurns', 'DamageTracking', 'Release', 'Interruptions');
		choice(fields.ConditionId, ['bide'], field('ConditionId'));
		const duration = integer(fields.DurationTurns, field('DurationTurns'), 2);
		const tracking = object(fields.DamageTracking, field('DamageTracking'), ['Source', 'Priority']);
		choice(tracking.Source, ['MovesWithSource'], field('DamageTracking.Source'));
		const priority = integer(tracking.Priority, field('DamageTracking.Priority'), -Number.MAX_SAFE_INTEGER);
		const release = object(fields.Release, field('Release'),
			['Multiplier', 'Target', 'Fallback', 'FailsWithoutStoredDamage', 'AlwaysHits', 'Flags', 'Category', 'MoveType', 'Priority']);
		const multiplier = numeric(release.Multiplier, field('Release.Multiplier'));
		choice(release.Target, ['LastDamageSource'], field('Release.Target'));
		choice(release.Fallback, ['RandomAdjacentFoe'], field('Release.Fallback'));
		nativeBoolean(release.FailsWithoutStoredDamage, field('Release.FailsWithoutStoredDamage'), true);
		nativeBoolean(release.AlwaysHits, field('Release.AlwaysHits'), true);
		const flags = Object.fromEntries(strings(release.Flags, field('Release.Flags')).map(flag => [flag, 1])) as Move['flags'];
		const category = choice(release.Category, ['Physical', 'Special'], field('Release.Category'));
		const type = string(release.MoveType, field('Release.MoveType'));
		const releasePriority = integer(release.Priority, field('Release.Priority'), -Number.MAX_SAFE_INTEGER);
		const interruptions = object(fields.Interruptions, field('Interruptions'), ['OnMoveAborted']);
		const onAbort = bool(interruptions.OnMoveAborted, field('Interruptions.OnMoveAborted'));
		const id = toID(move.name) as ID;
		const message = 'move: Bide';
		move.volatileStatus = id;
		move.beforeMoveCallback = user => user.volatiles[id] ? true : undefined;
		move.condition = {
			duration,
			onLockMove: id,
			onStart(user) {
				this.effectState.totalDamage = 0;
				this.add('-start', user, message);
			},
			onDamagePriority: priority,
			onDamage(damage, _target, source, effect) {
				if (!source || effect?.effectType !== 'Move') return;
				this.effectState.totalDamage += damage;
				this.effectState.lastDamageSource = source;
			},
			onBeforeMove(user) {
				if (this.effectState.duration !== 1) {
					this.add('-activate', user, message);
					return;
				}
				this.add('-end', user, message);
				let target: Pokemon | null = this.effectState.lastDamageSource;
				if (!target || !this.effectState.totalDamage) {
					this.attrLastMove('[still]');
					this.add('-fail', user);
					return false;
				}
				if (!target.isActive) target = this.getRandomTarget(user, 'pound');
				if (!target) {
					this.add('-miss', user);
					return false;
				}
				const counter: Partial<ActiveMove> = {
					id, name: 'Bide', accuracy: true, damage: this.effectState.totalDamage * multiplier,
					category, priority: releasePriority, flags, effectType: 'Move', type,
				};
				this.actions.tryMoveHit(target, user, counter as ActiveMove);
				user.removeVolatile(id);
				return false;
			},
			onMoveAborted(user) { if (onAbort) user.removeVolatile(id); },
			onEnd(user) { this.add('-end', user, message, '[silent]'); },
		};
		break;
	}
	case 'RepeatMoveOnHit': {
		keys('ConditionId', 'Requirements', 'Repeat', 'Power', 'Interruptions');
		choice(fields.ConditionId, ['rollout'], field('ConditionId'));
		const applies = when();
		const repeat = object(fields.Repeat, field('Repeat'), ['MaximumTurns', 'ReuseTargetSlot', 'SpendPPOnFirstUseOnly']);
		const limit = integer(repeat.MaximumTurns, field('Repeat.MaximumTurns'), 1);
		nativeBoolean(repeat.ReuseTargetSlot, field('Repeat.ReuseTargetSlot'), true);
		nativeBoolean(repeat.SpendPPOnFirstUseOnly, field('Repeat.SpendPPOnFirstUseOnly'), true);
		const power = object(fields.Power, field('Power'), ['MultiplierPerPreviousHit', 'ConditionalModifiers']);
		const growth = numeric(power.MultiplierPerPreviousHit, field('Power.MultiplierPerPreviousHit'));
		const modifiers = list(power.ConditionalModifiers, field('Power.ConditionalModifiers')).map((entry, index) => {
			const location = field(`Power.ConditionalModifiers[${index}]`);
			const modifier = object(entry, location, ['Requirements', 'Multiplier']);
			return { when: requirements(modifier.Requirements, `${location}.Requirements`),
				factor: numeric(modifier.Multiplier, `${location}.Multiplier`) };
		});
		matchProfile(fields.Interruptions, { OnHitFailure: true, OnMoveAborted: true, OnUserFaint: true,
			OnUserLeavesField: true, OnStruggle: true }, field('Interruptions'));
		const id = toID(move.name);
		move.onModifyMove = function (activeMove, user, target) {
			if (!target || user.volatiles[id] || !applies(this, user, target, activeMove)) return;
			user.addVolatile(id);
			if (activeMove.sourceEffect) user.lastMoveTargetLoc = user.getLocOf(target);
		};
		move.basePowerCallback = function (user, target, activeMove) {
			let amount = activeMove.basePower;
			const state = user.volatiles[id];
			if (state?.hitCount) amount *= growth ** state.contactHitCount;
			if (state && applies(this, user, target, activeMove)) {
				state.hitCount++;
				state.contactHitCount++;
				if (state.hitCount < limit) state.duration = 2;
			}
			for (const modifier of modifiers) {
				if (modifier.when(this, user, target, activeMove)) amount *= modifier.factor;
			}
			return amount;
		};
		move.onAfterMove = function (user) {
			const state = user.volatiles[id];
			if (state?.hitCount === limit && state.contactHitCount < limit) {
				user.addVolatile('rolloutstorage');
				user.volatiles.rolloutstorage.contactHitCount = state.contactHitCount;
			}
		};
		move.condition = {
			duration: 1,
			onLockMove: id,
			onStart() {
				this.effectState.hitCount = 0;
				this.effectState.contactHitCount = 0;
			},
			onResidual(user) { if (user.lastMove?.id === 'struggle') delete user.volatiles[id]; },
		};
		break;
	}
	case 'InterceptSwitch': {
		keys('ConditionId', 'DurationTurns', 'RequireAdjacentTarget', 'RequireQueuedAction',
			'RespectEncore', 'RunFormChangeBeforeMove', 'RemoveTargetVolatiles');
		const protocol = choice(fields.ConditionId, ['pursuit'], field('ConditionId'));
		const duration = integer(fields.DurationTurns, field('DurationTurns'), 1);
		const adjacent = bool(fields.RequireAdjacentTarget, field('RequireAdjacentTarget'));
		nativeBoolean(fields.RequireQueuedAction, field('RequireQueuedAction'), true);
		const encore = bool(fields.RespectEncore, field('RespectEncore'));
		const transform = bool(fields.RunFormChangeBeforeMove, field('RunFormChangeBeforeMove'));
		const remove = strings(fields.RemoveTargetVolatiles, field('RemoveTargetVolatiles'));
		const id = toID(move.name);
		move.beforeTurnCallback = function (user) { user.addVolatile(id, user, this.dex.getActiveMove(protocol)); };
		move.condition = {
			duration,
			onFoeBeforeSwitchOut(target) {
				const user: Pokemon = this.effectState.source;
				if (!user.hp || (adjacent && !user.isAdjacent(target)) ||
					(encore && user.volatiles.encore && user.volatiles.encore.move !== id) ||
					!this.queue.cancelMove(user)) return;
				if (!target.pursuitActivated) {
					this.add('-activate', target, 'move: Pursuit');
					target.pursuitActivated = true;
				}
				if (transform && (user.canMegaEvo || user.canUltraBurst || user.canTerastallize)) {
					for (const [index, action] of this.queue.entries()) {
						if (action.pokemon !== user) continue;
						if (action.choice === 'megaEvo') this.actions.runMegaEvo(user);
						else if (action.choice === 'terastallize') this.actions.terastallize(user);
						else continue;
						this.queue.list.splice(index, 1);
						break;
					}
				}
				for (const condition of remove) target.removeVolatile(publishedMoveId(this, condition));
				this.actions.runMove(id, user, user.getLocOf(target), { sourceEffect: this.effectState.sourceEffect });
			},
		};
		break;
	}
	case 'CombineQueuedMoves': {
		keys('Partners', 'ForceSTAB', 'ExcludeZMoves', 'ExcludeMaxMoves');
		const forceSTAB = bool(fields.ForceSTAB, field('ForceSTAB'));
		const excludeZ = bool(fields.ExcludeZMoves, field('ExcludeZMoves'));
		const excludeMax = bool(fields.ExcludeMaxMoves, field('ExcludeMaxMoves'));
		const combinations = new Map(list(fields.Partners, field('Partners')).map((entry, index) => {
			const location = field(`Partners[${index}]`);
			const partner = object(entry, location, ['MoveId', 'CombinedPower', 'CombinedType', 'SideCondition', 'Recipient',
				'DurationTurns', 'ResidualDamage', 'SpeedMultiplier', 'SecondaryChanceBoost']);
			const condition = choice(partner.SideCondition, ['firepledge', 'grasspledge', 'waterpledge'], `${location}.SideCondition`);
			matchProfile(partner.DurationTurns, 4, `${location}.DurationTurns`);
			if (condition === 'firepledge' || partner.ResidualDamage !== undefined) {
				choice(condition, ['firepledge'], `${location}.SideCondition`);
				matchProfile(partner.ResidualDamage, { Fraction: { Numerator: 1, Denominator: 8 }, HPBasis: 'BaseMaxHP',
					ImmuneTypes: ['Fire'], Order: 5, SubOrder: 1, SideEndOrder: 26, SideEndSubOrder: 8 }, `${location}.ResidualDamage`);
			}
			if (condition === 'grasspledge' || partner.SpeedMultiplier !== undefined) {
				choice(condition, ['grasspledge'], `${location}.SideCondition`);
				nativeFraction(partner.SpeedMultiplier, `${location}.SpeedMultiplier`, 1, 4);
			}
			if (partner.SecondaryChanceBoost !== undefined) {
				choice(condition, ['waterpledge'], `${location}.SideCondition`);
				matchProfile(partner.SecondaryChanceBoost, { Multiplier: 2, ExcludedMoveIds: ['secretpower'],
					ExcludeAbilityAndVolatile: { AbilityId: 'serenegrace', VolatileId: 'flinch' } }, `${location}.SecondaryChanceBoost`);
			}
			return [string(partner.MoveId, `${location}.MoveId`), {
				condition, power: integer(partner.CombinedPower, `${location}.CombinedPower`, 1),
				type: string(partner.CombinedType, `${location}.CombinedType`),
				recipient: choice(partner.Recipient, ['User', 'Target'], `${location}.Recipient`),
			}];
		}));
		const combination = (id: string) => combinations.get(id) ?? combinations.get(id.replace(/^nomelat/, ''));
		move.basePowerCallback = function (_user, _target, activeMove) {
			const partner = combination(activeMove.sourceEffect);
			if (!partner) return activeMove.basePower;
			this.add('-combine');
			return partner.power;
		};
		move.onPrepareHit = function (_target, user, activeMove) {
			for (const action of this.queue.list as MoveAction[]) {
				if (!action.move || !action.pokemon?.isActive || action.pokemon.fainted || !action.pokemon.isAlly(user) ||
					(excludeZ && action.zmove) || (excludeMax && action.maxMove) || !combination(action.move.id)) continue;
				this.queue.prioritizeAction(action, activeMove);
				this.add('-waiting', user, action.pokemon);
				return null;
			}
		};
		move.onModifyMove = function (activeMove) {
			const partner = combination(activeMove.sourceEffect);
			if (!partner) return;
			activeMove.type = partner.type;
			activeMove.forceSTAB = forceSTAB;
			if (partner.recipient === 'User') activeMove.self = { sideCondition: partner.condition };
			else activeMove.sideCondition = partner.condition;
		};
		break;
	}
	case 'ApplyEffectAt':
		attachEffect(move, fields, path);
		break;
	case 'ChargeThenHit': {
		keys('DurationTurns', 'Mode', 'CanSkipCharge', 'BeforeCharge', 'ChargingEffect', 'SkipChargeWhen', 'DelayAnimationUntilHit',
			'IncomingMoves', 'ResidualImmunities');
		const mode = choice(fields.Mode, ['Exposed', 'Airborne', 'Underground', 'Underwater', 'SemiInvulnerable'], field('Mode'));
		if (mode === 'Exposed' && ('IncomingMoves' in fields || 'ResidualImmunities' in fields)) {
			invalid(path, 'the exposed mode has no incoming move rules');
		}
		if (mode !== 'Exposed') {
			if (move.condition) invalid(path, 'already has a move condition');
			const condition = semiInvulnerableCondition(mode, fields, path, move.name);
			move.condition = {
				onStart(target) { target.addVolatile(condition); },
				onEnd(target) { target.removeVolatile(condition); },
			};
		}
		integer(fields.DurationTurns, field('DurationTurns'), 2, 2);
		const canSkip = bool(fields.CanSkipCharge, field('CanSkipCharge'));
		const skip = fields.SkipChargeWhen === undefined ? undefined : requirements(fields.SkipChargeWhen, field('SkipChargeWhen'));
		if (fields.DelayAnimationUntilHit !== undefined && !bool(fields.DelayAnimationUntilHit, field('DelayAnimationUntilHit'))) {
			invalid(field('DelayAnimationUntilHit'), 'the two-turn condition delays the animation');
		}
		if ('BeforeCharge' in fields && 'ChargingEffect' in fields) invalid(path, 'expected one charging effect');
		let charge: EffectAction | undefined;
		let chargeApplies: Requirement | undefined;
		if (fields.BeforeCharge !== undefined) {
			const before = object(fields.BeforeCharge, field('BeforeCharge'), ['Recipient', 'Effect', 'Requirements']);
			choice(before.Recipient, ['User'], field('BeforeCharge.Recipient'));
			charge = eventEffect(before.Effect, field('BeforeCharge.Effect'));
			chargeApplies = requirements(before.Requirements, field('BeforeCharge.Requirements'));
		} else if (fields.ChargingEffect !== undefined) {
			charge = eventEffect(fields.ChargingEffect, field('ChargingEffect'));
		}
		if (move.onTryMove) invalid(path, 'charging conflicts with another move-start effect');
		move.onTryMove = function (user, target, activeMove) {
			if (user.removeVolatile(activeMove.id)) return;
			const chargeEffect = !chargeApplies || chargeApplies(this, user, target, activeMove) ? charge : undefined;
			if (mode === 'Underwater') chargeEffect?.(this, user, user, activeMove);
			this.add('-prepare', user, activeMove.name);
			if (mode !== 'Underwater') chargeEffect?.(this, user, user, activeMove);
			if (skip?.(this, user, target, activeMove)) {
				this.attrLastMove('[still]');
				this.addMove('-anim', user, activeMove.name, target);
				return;
			}
			if (canSkip && !this.runEvent('ChargeMove', user, target, activeMove)) return;
			user.addVolatile('twoturnmove', target);
			return null;
		};
		break;
	}
	case 'ProtectSide': {
		keys('ConditionId', 'DurationTurns', 'RequiresActionRemaining', 'TryHitPriority',
			'BlockedMoveCategories', 'ExcludedTargets', 'IncludedTargets', 'MinimumMovePriority',
			'AddUseCounter', 'ResetLockedMoveAtTwoTurns');
		const condition = choice(fields.ConditionId, ['craftyshield', 'quickguard', 'wideguard'], field('ConditionId'));
		integer(fields.DurationTurns, field('DurationTurns'), 1, 1);
		const crafty = condition === 'craftyshield';
		const priority = crafty ? 3 : 4;
		integer(fields.TryHitPriority, field('TryHitPriority'), priority, priority);
		nativeOptions(fields.BlockedMoveCategories, field('BlockedMoveCategories'), crafty ? ['Status'] : ['Physical', 'Special', 'Status']);
		if (crafty || 'ExcludedTargets' in fields) nativeOptions(fields.ExcludedTargets, field('ExcludedTargets'), crafty ? ['self', 'all'] : []);
		if (condition === 'wideguard' || 'IncludedTargets' in fields) {
			nativeOptions(fields.IncludedTargets, field('IncludedTargets'), condition === 'wideguard' ? ['allAdjacent', 'allAdjacentFoes'] : []);
		}
		if (condition === 'quickguard' && numeric(fields.MinimumMovePriority, field('MinimumMovePriority')) !== 0.1) {
			invalid(field('MinimumMovePriority'), 'Quick Guard uses 0.1');
		}
		if (condition !== 'quickguard' && 'MinimumMovePriority' in fields) invalid(field('MinimumMovePriority'), 'expected Quick Guard');
		const requiresAction = bool(fields.RequiresActionRemaining, field('RequiresActionRemaining'));
		if (!crafty) choice(fields.AddUseCounter, ['stall'], field('AddUseCounter'));
		else if ('AddUseCounter' in fields) invalid(field('AddUseCounter'), 'Crafty Shield does not add a counter');
		if (!crafty || 'ResetLockedMoveAtTwoTurns' in fields) {
			nativeBoolean(fields.ResetLockedMoveAtTwoTurns, field('ResetLockedMoveAtTwoTurns'), !crafty);
		}
		if (move.sideCondition || move.onTry || move.onHitSide) invalid(path, 'side protection conflicts with another effect');
		move.sideCondition = condition;
		move.onTry = function () { return !requiresAction || !!this.queue.willAct(); };
		if (!crafty) move.onHitSide = function (_side, source) { source.addVolatile('stall'); };
		break;
	}
	case 'CrashOnFailure': {
		keys('Fraction');
		const [n, d] = fraction(fields.Fraction, field('Fraction'));
		if (move.onMoveFail) invalid(path, 'already has a failure effect');
		move.hasCrashDamage = true;
		move.onMoveFail = function (_target, user, activeMove) {
			this.damage(user.baseMaxhp * n / d, user, user, this.dex.conditions.get(activeMove.id));
		};
		break;
	}
	case 'PayHPOnAttempt': {
		keys('Fraction', 'HPBasis', 'Rounding', 'IncludeFailure', 'SkipOnMultihitFailure');
		nativeFraction(fields.Fraction, field('Fraction'), 1, 2);
		choice(fields.HPBasis, ['MaxHP'], field('HPBasis'));
		choice(fields.Rounding, ['Nearest'], field('Rounding'));
		nativeBoolean(fields.IncludeFailure, field('IncludeFailure'), true);
		nativeBoolean(fields.SkipOnMultihitFailure, field('SkipOnMultihitFailure'), true);
		if (move.onMoveFail) invalid(path, 'already has a failure effect');
		move.mindBlownRecoil = true;
		move.onMoveFail = function (_target, user, activeMove) {
			if (!activeMove.multihit) this.damage(Math.round(user.maxhp / 2), user, user, this.dex.conditions.get(activeMove.id));
		};
		break;
	}
	case 'Retaliate':
	case 'RetaliateLastDamage':
		attachRetaliation(move, fields, path);
		break;
	case 'LeaveTargetHP': {
		keys('MinimumHP', 'Priority');
		const minimum = integer(fields.MinimumHP, field('MinimumHP'), 1);
		move.onDamagePriority = integer(fields.Priority, field('Priority'), -Number.MAX_SAFE_INTEGER);
		move.onDamage = (damage, target) => damage >= target.hp - minimum ? Math.max(0, target.hp - minimum) : undefined;
		break;
	}
	case 'SkipPursuitOnSwitch': {
		keys();
		move.self = { ...move.self, onHit(user) { user.skipPursuit = true; } };
		break;
	}
	case 'AnnounceBeforeMove': {
		keys('DurationTurns', 'Priority', 'Event', 'Tag');
		const duration = integer(fields.DurationTurns, field('DurationTurns'), 1);
		const priority = integer(fields.Priority, field('Priority'), -Number.MAX_SAFE_INTEGER);
		choice(fields.Event, ['Prepare'], field('Event'));
		choice(fields.Tag, ['PreMajor'], field('Tag'));
		if (move.condition || move.priorityChargeCallback) invalid(path, 'already has a preparation condition');
		const id = toID(move.name);
		move.priorityChargeCallback = function (user) { user.addVolatile(id); };
		move.condition = {
			duration, onBeforeMovePriority: priority,
			onBeforeMove(user, _target, activeMove) {
				if (activeMove.id === id) this.add('-prepare', user, activeMove.name, '[premajor]');
			},
		};
		break;
	}
	case 'ChargeBeforeAction':
	case 'FocusBeforeMove':
	case 'TriggerMoveWhenHit': {
		const branch = fields.Type;
		const id = branch === 'ChargeBeforeAction' ? 'beakblast' : branch === 'FocusBeforeMove' ? 'focuspunch' : 'shelltrap';
		choice(fields.ConditionId, [id], field('ConditionId'));
		integer(fields.DurationTurns, field('DurationTurns'), 1, 1);
		move.priorityChargeCallback = function (user) { user.addVolatile(id); };
		if (branch === 'ChargeBeforeAction') {
			keys('ConditionId', 'DurationTurns', 'ClearAfterMove', 'OnContact');
			const contact = object(fields.OnContact, field('OnContact'), ['Type', 'Status']);
			choice(contact.Type, ['ApplyStatus'], field('OnContact.Type'));
			choice(contact.Status, ['Burn'], field('OnContact.Status'));
			nativeBoolean(fields.ClearAfterMove, field('ClearAfterMove'), true);
			move.onAfterMove = function (user) { user.removeVolatile(id); };
		} else if (branch === 'FocusBeforeMove') {
			keys('ConditionId', 'DurationTurns', 'CancelOnDamageCategories', 'BlockedVolatiles');
			nativeOptions(fields.CancelOnDamageCategories, field('CancelOnDamageCategories'), ['Physical', 'Special']);
			nativeOptions(fields.BlockedVolatiles, field('BlockedVolatiles'), ['flinch']);
			move.beforeMoveCallback = function (user) {
				if (!user.volatiles[id]?.lostFocus) return;
				this.add('cant', user, 'Focus Punch', 'Focus Punch');
				return true;
			};
		} else {
			keys('ConditionId', 'DurationTurns', 'DamageCategories', 'FoesOnly', 'PrioritizeQueuedMove', 'FailUnlessTriggered');
			nativeOptions(fields.DamageCategories, field('DamageCategories'), ['Physical']);
			for (const name of ['FoesOnly', 'PrioritizeQueuedMove', 'FailUnlessTriggered']) nativeBoolean(fields[name], field(name), true);
			move.onTryMove = function (user) {
				if (user.volatiles[id]?.gotHit) return;
				this.attrLastMove('[still]');
				this.add('cant', user, 'Shell Trap', 'Shell Trap');
				return null;
			};
		}
		break;
	}
	case 'BuildFieldPower': {
		keys('FieldConditionId', 'DurationTurns', 'ApplyAt', 'InitialMultiplier', 'Step', 'MaximumMultiplier', 'IncreaseOncePerTurn');
		const id = choice(fields.FieldConditionId, ['echoedvoice'], field('FieldConditionId'));
		choice(fields.ApplyAt, ['TryMoveEvent'], field('ApplyAt'));
		integer(fields.DurationTurns, field('DurationTurns'), 2, 2);
		integer(fields.InitialMultiplier, field('InitialMultiplier'), 1, 1);
		integer(fields.Step, field('Step'), 1, 1);
		integer(fields.MaximumMultiplier, field('MaximumMultiplier'), 5, 5);
		nativeBoolean(fields.IncreaseOncePerTurn, field('IncreaseOncePerTurn'), true);
		const previous = move.onTryMove;
		move.onTryMove = function (user, target, activeMove) {
			const result = typeof previous === 'function' ? previous.call(this, user, target, activeMove) : previous;
			if (result !== false && result !== null) this.field.addPseudoWeather(id, user, activeMove);
			return result;
		};
		basePowerCalculation(move, path, function (_user, _target, activeMove) {
			return activeMove.basePower * (this.field.pseudoWeather[id]?.multiplier ?? 1);
		});
		break;
	}
	case 'BuildMovePower': {
		keys('ConditionId', 'DurationTurns', 'InitialMultiplier', 'StepMultiplier', 'MaximumMultiplier', 'MinimumPower',
			'MaximumPower', 'IncreaseOnlyOnFirstHit');
		const id = choice(fields.ConditionId, ['furycutter'], field('ConditionId'));
		integer(fields.DurationTurns, field('DurationTurns'), 2, 2);
		integer(fields.InitialMultiplier, field('InitialMultiplier'), 1, 1);
		integer(fields.StepMultiplier, field('StepMultiplier'), 2, 2);
		integer(fields.MaximumMultiplier, field('MaximumMultiplier'), 4, 4);
		const min = integer(fields.MinimumPower, field('MinimumPower'), 1);
		const max = integer(fields.MaximumPower, field('MaximumPower'), min);
		const first = bool(fields.IncreaseOnlyOnFirstHit, field('IncreaseOnlyOnFirstHit'));
		basePowerCalculation(move, path, function (user, _target, activeMove) {
			if (!user.volatiles[id] || !first || activeMove.hit === 1) user.addVolatile(id);
			return this.clampIntRange(activeMove.basePower * (user.volatiles[id]?.multiplier ?? 1), min, max);
		});
		break;
	}
	case 'UseTypelessDamage': {
		keys();
		const previous = move.onModifyMove;
		move.onModifyMove = function (activeMove, user, target) {
			previous?.call(this, activeMove, user, target);
			activeMove.type = '???';
			this.add('-activate', user, `move: ${activeMove.name}`);
		};
		break;
	}
	case 'PayHPOnSuccess': {
		keys('HPBasis', 'Fraction', 'Rounding');
		choice(fields.HPBasis, ['BaseMaxHP'], field('HPBasis'));
		nativeFraction(fields.Fraction, field('Fraction'), 1, 4);
		choice(fields.Rounding, ['Nearest'], field('Rounding'));
		move.struggleRecoil = true;
		break;
	}
	case 'ChooseMoveOutcome': {
		keys('ApplyAt', 'Outcomes');
		choice(fields.ApplyAt, ['ModifyMove'], field('ApplyAt'));
		const outcomes = list(fields.Outcomes, field('Outcomes')).map((value, index) => {
			const location = `${field('Outcomes')}[${index}]`;
			const outcome = object(value, location, ['Weight', 'PrimaryEffect', 'BasePower', 'Infiltrates']);
			const weight = integer(outcome.Weight, `${location}.Weight`, 1);
			const delta: Partial<MoveData> = {};
			if ('BasePower' in outcome) delta.basePower = integer(outcome.BasePower, `${location}.BasePower`);
			if ('PrimaryEffect' in outcome) {
				const effectPath = `${location}.PrimaryEffect`;
				Object.assign(delta, hitEffect(outcome.PrimaryEffect, effectPath));
				const apply = delta.onHit;
				if (object(outcome.PrimaryEffect, effectPath).Type === 'Heal' && typeof apply === 'function') {
					delta.onHit = function (target, user, activeMove) {
						if (target.hp >= target.maxhp) {
							this.add('-fail', target, 'heal');
							this.attrLastMove('[still]');
							return this.NOT_FAIL;
						}
						return apply.call(this, target, user, activeMove);
					};
				}
			}
			if ('Infiltrates' in outcome) delta.infiltrates = bool(outcome.Infiltrates, `${location}.Infiltrates`);
			return { weight, delta };
		});
		const sum = outcomes.reduce((total, outcome) => total + outcome.weight, 0);
		if (!sum) invalid(field('Outcomes'), 'expected at least one outcome');
		const previous = move.onModifyMove;
		move.onModifyMove = function (activeMove, user, target) {
			previous?.call(this, activeMove, user, target);
			let roll = this.random(sum);
			for (const outcome of outcomes) {
				roll -= outcome.weight;
				if (roll >= 0) continue;
				Object.assign(activeMove, outcome.delta);
				break;
			}
		};
		break;
	}
	case 'ChooseDamageCategoryByEstimatedDamage': {
		keys('BasePower', 'PhysicalOnTieChance', 'PhysicalMakesContact', 'RevealToFoes');
		const base = integer(fields.BasePower, field('BasePower'), 1);
		const [n, d] = fraction(fields.PhysicalOnTieChance, field('PhysicalOnTieChance'));
		const contact = bool(fields.PhysicalMakesContact, field('PhysicalMakesContact'));
		const reveal = bool(fields.RevealToFoes, field('RevealToFoes'));
		const previous = move.onModifyMove;
		move.onModifyMove = function (activeMove, user, target) {
			previous?.call(this, activeMove, user, target);
			if (!target) return;
			const damage = (offensive: MoveStat, defensive: MoveStat) =>
				Math.floor(Math.floor(Math.floor((2 * user.level / 5 + 2) * base * user.getStat(offensive, false, true)) /
					target.getStat(defensive, false, true)) / 50);
			const physical = damage('atk', 'def');
			const special = damage('spa', 'spd');
			if (physical > special || (physical === special && this.randomChance(n, d))) {
				activeMove.category = 'Physical';
				if (contact) activeMove.flags.contact = 1;
			}
		};
		if (reveal) {
			move.onPrepareHit = function (target, user, activeMove) {
				if (!user.isAlly(target)) this.attrLastMove(`[anim] ${activeMove.name} ${activeMove.category}`);
			};
			move.onHit = function (target, user, activeMove) {
				if (!user.isAlly(target)) this.hint(`${activeMove.category} ${activeMove.name}`);
			};
			move.onAfterSubDamage = function (_damage, target, user, activeMove) {
				if (!user.isAlly(target)) this.hint(`${activeMove.category} ${activeMove.name}`);
			};
		}
		break;
	}
	case 'ProtectUser': {
		keys('ConditionId', 'DurationTurns', 'ConsecutiveUseCounter', 'RequiresActionRemaining',
			'ResetLockedMoveAtTwoTurns', 'Survival', 'OnContact', 'TriggerOnZOrMaxContact', 'BlockedMoveCategories');
		const condition = protectionCondition(fields, path);
		const counter = choice(fields.ConsecutiveUseCounter, ['stall'], field('ConsecutiveUseCounter'));
		const requiresAction = bool(fields.RequiresActionRemaining, field('RequiresActionRemaining'));
		if (move.volatileStatus || move.onPrepareHit || move.onHit) invalid(path, 'protection conflicts with another hit effect');
		move.stallingMove = true;
		move.volatileStatus = condition;
		move.onPrepareHit = function (pokemon) {
			return (!requiresAction || !!this.queue.willAct()) && this.runEvent('StallMove', pokemon);
		};
		move.onHit = function (pokemon) { pokemon.addVolatile(counter); };
		break;
	}
	case 'PowerByHitIndex': {
		keys('PowerPerHit');
		const power = integer(fields.PowerPerHit, field('PowerPerHit'), 1);
		basePowerCalculation(move, path, (_user, _target, activeMove) => power * activeMove.hit);
		break;
	}
	case 'PowerByWeightSteps': {
		keys('Subject', 'ComparedWith', 'Steps', 'DefaultPower');
		const subject = activePokemon(fields.Subject, field('Subject'));
		const relative = fields.ComparedWith === undefined ? undefined : activePokemon(fields.ComparedWith, field('ComparedWith'));
		const threshold = relative ? 'Factor' : 'Kilograms';
		const fallback = integer(fields.DefaultPower, field('DefaultPower'), 1);
		const table = list(fields.Steps, field('Steps')).map((entry, i) => {
			const location = `${field('Steps')}[${i}]`;
			const step = object(entry, location, [threshold, 'BasePower']);
			return { limit: numeric(step[threshold], `${location}.${threshold}`), power: integer(step.BasePower, `${location}.BasePower`, 1) };
		}).sort((a, b) => b.limit - a.limit);
		basePowerCalculation(move, path, (user, target) => {
			const weight = subject(user, target).getWeight();
			const unit = relative ? relative(user, target).getWeight() : 10;
			return table.find(step => weight >= step.limit * unit)?.power ?? fallback;
		});
		break;
	}
	case 'PowerByHPRatioSteps': {
		keys('Subject', 'Scale', 'MinimumRatio', 'DefaultPower', 'Steps');
		const subject = activePokemon(fields.Subject, field('Subject'));
		const scale = integer(fields.Scale, field('Scale'), 1);
		const min = integer(fields.MinimumRatio, field('MinimumRatio'));
		const fallback = integer(fields.DefaultPower, field('DefaultPower'), 1);
		const table = list(fields.Steps, field('Steps')).map((entry, i) => {
			const location = `${field('Steps')}[${i}]`;
			const step = object(entry, location, ['Below', 'BasePower']);
			return { below: integer(step.Below, `${location}.Below`, 1), power: integer(step.BasePower, `${location}.BasePower`, 1) };
		}).sort((a, b) => a.below - b.below);
		basePowerCalculation(move, path, (user, target) => {
			const pokemon = subject(user, target);
			const ratio = Math.max(min, Math.floor(pokemon.hp * scale / pokemon.maxhp));
			return table.find(step => ratio < step.below)?.power ?? fallback;
		});
		break;
	}
	case 'PowerByStatRatio': {
		keys('Stat', 'NumeratorSubject', 'DenominatorSubject', 'Rounding', 'Formula', 'PowerByRatio', 'NonFiniteRatio');
		const stat = lookup(fields.Stat, stats, field('Stat'));
		const numerator = activePokemon(fields.NumeratorSubject, field('NumeratorSubject'));
		const denominator = activePokemon(fields.DenominatorSubject, field('DenominatorSubject'));
		choice(fields.Rounding, ['Floor'], field('Rounding'));
		const ratio = (user: Pokemon, target: Pokemon) => numerator(user, target).getStat(stat) / denominator(user, target).getStat(stat);
		if (fields.Formula !== undefined) {
			if (fields.PowerByRatio !== undefined || fields.NonFiniteRatio !== undefined) invalid(path, 'choose a formula or a table');
			const formula = object(fields.Formula, field('Formula'), ['Scale', 'Offset', 'MaximumPower', 'NonFinitePower']);
			const scale = integer(formula.Scale, field('Formula.Scale'), 1);
			const offset = integer(formula.Offset, field('Formula.Offset'));
			const maximum = integer(formula.MaximumPower, field('Formula.MaximumPower'), 1);
			const fallback = integer(formula.NonFinitePower, field('Formula.NonFinitePower'), 1);
			basePowerCalculation(move, path, (user, target) => {
				const power = Math.floor(scale * ratio(user, target)) + offset;
				return Math.min(maximum, Number.isFinite(power) ? power : fallback);
			});
		} else {
			const table = list(fields.PowerByRatio, field('PowerByRatio')).map((power, index) =>
				integer(power, `${field('PowerByRatio')}[${index}]`, 1));
			const fallback = integer(fields.NonFiniteRatio, field('NonFiniteRatio'));
			if (!table.length) invalid(field('PowerByRatio'), 'expected at least one value');
			basePowerCalculation(move, path, (user, target) => {
				const value = Math.floor(ratio(user, target));
				return table[Math.min(table.length - 1, Number.isFinite(value) ? value : fallback)];
			});
		}
		break;
	}
	case 'ScalePowerByHP': {
		keys('Subject', 'Scale', 'MinimumPower', 'Rounding', 'UseMoveBasePower');
		const subject = activePokemon(fields.Subject, field('Subject'));
		const scale = integer(fields.Scale, field('Scale'), 1);
		const min = integer(fields.MinimumPower, field('MinimumPower'));
		const rounding = choice(fields.Rounding, ['None', 'Floor', 'Ceiling', 'Nearest', 'ShowdownFixedPoint'], field('Rounding'));
		const useBase = fields.UseMoveBasePower === undefined ? false : bool(fields.UseMoveBasePower, field('UseMoveBasePower'));
		const round = { None: (x: number) => x, Floor: Math.floor, Ceiling: Math.ceil, Nearest: Math.round,
			ShowdownFixedPoint: Math.floor }[rounding];
		basePowerCalculation(move, path, (user, target, activeMove) => {
			const pokemon = subject(user, target);
			const reference = useBase ? activeMove.basePower : scale;
			if (rounding === 'ShowdownFixedPoint') {
				const fixed = 100 * Math.floor(pokemon.hp * 4096 / pokemon.maxhp) + 2047;
				return Math.max(min, Math.floor(Math.floor(reference * fixed / 4096) / 100));
			}
			return Math.max(min, round(reference * pokemon.hp / pokemon.maxhp));
		});
		break;
	}
	case 'PowerByPositiveStatStages': {
		keys('ExtraPowerPerStage');
		const step = integer(fields.ExtraPowerPerStage, field('ExtraPowerPerStage'), 1);
		basePowerCalculation(move, path, (user, _target, activeMove) => activeMove.basePower + step * user.positiveBoosts());
		break;
	}
	case 'PowerByVolatileLayers': {
		keys('Subject', 'ConditionId', 'PowerPerLayer');
		const subject = activePokemon(fields.Subject, field('Subject'));
		const condition = string(fields.ConditionId, field('ConditionId'));
		const power = integer(fields.PowerPerLayer, field('PowerPerLayer'), 1);
		basePowerCalculation(move, path, (user, target) => {
			const layers = subject(user, target).volatiles[condition]?.layers;
			return layers ? layers * power : false;
		});
		break;
	}
	case 'PowerBySideFaints': {
		keys('ExtraPowerPerFaint');
		const step = integer(fields.ExtraPowerPerFaint, field('ExtraPowerPerFaint'), 1);
		basePowerCalculation(move, path, (user, _target, activeMove) => activeMove.basePower + step * user.side.totalFainted);
		break;
	}
	case 'PowerByTimesHit': {
		keys('ExtraPowerPerHit', 'MaximumPower');
		const step = integer(fields.ExtraPowerPerHit, field('ExtraPowerPerHit'), 1);
		const cap = integer(fields.MaximumPower, field('MaximumPower'), 1);
		basePowerCalculation(move, path, (user, _target, activeMove) => Math.min(cap, activeMove.basePower + step * user.timesAttacked));
		break;
	}
	case 'AddBasePower': {
		keys('ApplyAt', 'Requirements', 'Amount');
		choice(fields.ApplyAt, ['CalculateBasePower'], field('ApplyAt'));
		const applies = when();
		const amount = integer(fields.Amount, field('Amount'), -Number.MAX_SAFE_INTEGER);
		basePowerCalculation(move, path, function (user, target, activeMove) {
			return activeMove.basePower + (applies(this, user, target, activeMove) ? amount : 0);
		});
		break;
	}
	case 'PrioritizeMatchingQueuedMove': {
		keys('ExcludeZMoves', 'ExcludeMaxMoves');
		const z = bool(fields.ExcludeZMoves, field('ExcludeZMoves'));
		const max = bool(fields.ExcludeMaxMoves, field('ExcludeMaxMoves'));
		if (move.onTry) invalid(path, 'already has an attempt handler');
		move.onTry = function (_user, _target, activeMove) {
			for (const action of this.queue.list) {
				if (action.choice !== 'move' || action.move.id !== activeMove.id || (z && action.zmove) || (max && action.maxMove)) continue;
				this.queue.prioritizeAction(action, activeMove);
				break;
			}
		};
		break;
	}
	case 'ModifyBasePower': {
		keys('ApplyAt', 'Requirements', 'Multiplier', 'MultiplierFraction', 'OnApplied');
		const at = choice(fields.ApplyAt, ['CalculateBasePower', 'ModifyBasePower', 'ModifyMove'], field('ApplyAt'));
		const applies = when();
		const notify = fields.OnApplied === undefined ? undefined : eventEffect(fields.OnApplied, field('OnApplied'));
		let ratio: number | [number, number];
		if (fields.MultiplierFraction !== undefined) {
			if (fields.Multiplier !== undefined) invalid(path, 'choose one multiplier');
			const parts = object(fields.MultiplierFraction, field('MultiplierFraction'), ['Numerator', 'Denominator']);
			ratio = [integer(parts.Numerator, field('MultiplierFraction.Numerator')),
				integer(parts.Denominator, field('MultiplierFraction.Denominator'), 1)];
		} else {
			ratio = numeric(fields.Multiplier, field('Multiplier'));
		}
		const factor = typeof ratio === 'number' ? ratio : ratio[0] / ratio[1];
		if (at === 'CalculateBasePower') {
			const previous = move.basePowerCallback;
			move.basePowerCallback = function (user, target, activeMove) {
				const base = previous ? previous.call(this, user, target, activeMove) : activeMove.basePower;
				if (typeof base !== 'number' || !applies(this, user, target, activeMove)) return base;
				notify?.(this, user, user, activeMove);
				return base * factor;
			};
		} else if (at === 'ModifyMove') {
			const previous = move.onModifyMove;
			move.onModifyMove = function (activeMove, user, target) {
				previous?.call(this, activeMove, user, target);
				if (applies(this, user, target, activeMove)) {
					notify?.(this, user, user, activeMove);
					activeMove.basePower *= factor;
				}
			};
		} else {
			const previous = move.onBasePower;
			move.onBasePower = function (base, user, target, activeMove) {
				const result = previous?.call(this, base, user, target, activeMove);
				if (applies(this, user, target, activeMove)) {
					notify?.(this, user, user, activeMove);
					return this.chainModify(ratio);
				}
				return result;
			};
		}
		break;
	}
	case 'ModifyAccuracy': {
		keys('ApplyAt', 'Requirements', 'AlwaysHits', 'Accuracy', 'TracksTarget');
		choice(fields.ApplyAt, ['ModifyMove'], field('ApplyAt'));
		if ((fields.AlwaysHits !== undefined) === (fields.Accuracy !== undefined)) invalid(path, 'choose one accuracy');
		const accuracy = fields.AlwaysHits !== undefined ?
			bool(fields.AlwaysHits, field('AlwaysHits')) : integer(fields.Accuracy, field('Accuracy'), 1, 100);
		if (accuracy === false) invalid(field('AlwaysHits'), 'expected true');
		const tracks = fields.TracksTarget === undefined ? undefined : bool(fields.TracksTarget, field('TracksTarget'));
		const applies = when();
		const previous = move.onModifyMove;
		move.onModifyMove = function (activeMove, user, target) {
			previous?.call(this, activeMove, user, target);
			if (!applies(this, user, target, activeMove)) return;
			activeMove.accuracy = accuracy;
			if (tracks !== undefined) activeMove.tracksTarget = tracks;
		};
		break;
	}
	case 'ModifyMoveType': {
		keys('Requirements', 'MoveType');
		const type = string(fields.MoveType, field('MoveType'));
		const applies = when();
		const previous = move.onModifyType;
		move.onModifyType = function (activeMove, user, target) {
			previous?.call(this, activeMove, user, target);
			if (applies(this, user, target, activeMove)) activeMove.type = type;
		};
		break;
	}
	case 'OverrideTypeImmunity': {
		keys('MoveType', 'NeutralIfTargetImmuneAndHasType');
		const type = string(fields.MoveType, field('MoveType'));
		const neutral = fields.NeutralIfTargetImmuneAndHasType === undefined ? undefined :
			string(fields.NeutralIfTargetImmuneAndHasType, field('NeutralIfTargetImmuneAndHasType'));
		if (move.ignoreImmunity !== true) move.ignoreImmunity = { ...(move.ignoreImmunity || {}), [type]: true };
		if (neutral) {
			const previous = move.onEffectiveness;
			move.onEffectiveness = function (modifier, target, defendingType, activeMove) {
				const result = previous?.call(this, modifier, target, defendingType, activeMove);
				if (activeMove.type === type && target?.hasType(neutral) && !target.runImmunity(type)) return 0;
				return result;
			};
		}
		break;
	}
	case 'OverrideTarget': {
		keys('Requirements', 'Target');
		const targetType = choice(fields.Target, targets, field('Target'));
		const applies = when();
		const previous = move.onModifyMove;
		move.onModifyMove = function (activeMove, user, target) {
			previous?.call(this, activeMove, user, target);
			if (applies(this, user, target, activeMove)) activeMove.target = targetType;
		};
		break;
	}
	case 'UseTypeAnimation': {
		keys('ApplyAt', 'Requirements', 'DefaultType');
		choice(fields.ApplyAt, ['PrepareHit'], field('ApplyAt'));
		const fallback = string(fields.DefaultType, field('DefaultType'));
		const applies = when();
		const explicit = fields.Requirements !== undefined;
		const previous = move.onPrepareHit;
		move.onPrepareHit = function (target, user, activeMove) {
			const result = typeof previous === 'function' ? previous.call(this, target, user, activeMove) : previous;
			if (result === false || result === null || result === '') return result;
			if (applies(this, user, target, activeMove) && (explicit || activeMove.type !== fallback)) {
				this.attrLastMove(`[anim] ${activeMove.name} ${activeMove.type}`);
			}
			return result;
		};
		break;
	}
	case 'ConditionalMove': {
		keys('Cases');
		const variants = list(fields.Cases, field('Cases')).map((entry, index) => {
			const location = `${field('Cases')}[${index}]`;
			const variant = object(entry, location,
				['Requirements', 'Target', 'TargetFallback', 'BasePower', 'PrimaryEffect', 'SelfEffect', 'Infiltrates']);
			const apply = requirements(list(variant.Requirements, `${location}.Requirements`), `${location}.Requirements`);
			const delta: Partial<MoveData> = {};
			if ('Target' in variant) delta.target = choice(variant.Target, targets, `${location}.Target`);
			const fallback = variant.TargetFallback === undefined ? undefined : object(variant.TargetFallback,
				`${location}.TargetFallback`, ['Target', 'When']);
			const fallbackTarget = fallback && choice(fallback.Target, targets, `${location}.TargetFallback.Target`);
			const fallbackWhen = fallback && list(fallback.When, `${location}.TargetFallback.When`).map((rule, i) =>
				choice(rule, ['NoTarget', 'AllyTarget'], `${location}.TargetFallback.When[${i}]`));
			if ('BasePower' in variant) delta.basePower = integer(variant.BasePower, `${location}.BasePower`);
			if ('Infiltrates' in variant) delta.infiltrates = bool(variant.Infiltrates, `${location}.Infiltrates`);
			if ('SelfEffect' in variant) delta.self = hitEffect(variant.SelfEffect, `${location}.SelfEffect`);
			const effectPath = `${location}.PrimaryEffect`;
			const effect = 'PrimaryEffect' in variant ? object(variant.PrimaryEffect, effectPath) : undefined;
			const primary = effect && hitEffect(effect, effectPath);
			if (!Object.keys(delta).length && !primary) invalid(location, 'expected a move change');
			return { apply, delta, primary, fallbackTarget, fallbackWhen };
		});
		const previous = move.onModifyMove;
		move.onModifyMove = function (activeMove, user, target) {
			previous?.call(this, activeMove, user, target);
			const variant = variants.find(entry => entry.apply(this, user, target, activeMove));
			if (!variant) return;
			Object.assign(activeMove, variant.delta);
			if (variant.fallbackTarget && ((!target && variant.fallbackWhen?.includes('NoTarget')) ||
				(target && user.isAlly(target) && variant.fallbackWhen?.includes('AllyTarget')))) {
				activeMove.target = variant.fallbackTarget;
			}
			if (variant.primary) {
				for (const key of ['boosts', 'status', 'volatileStatus', 'sideCondition', 'slotCondition',
					'pseudoWeather', 'terrain', 'weather', 'heal', 'onHit'] as const) {
					delete activeMove[key];
				}
				Object.assign(activeMove, variant.primary);
				if (variant.primary.volatileStatus === 'curse') {
					activeMove.onTryHit = target => target.volatiles.curse ? false : undefined;
				}
			}
		};
		break;
	}
	case 'ModifyMoveTypeFromUser': {
		keys('Source', 'Requirements', 'DefaultType', 'ExcludeZCrystals', 'FallbackToSecondType');
		const source = choice(fields.Source, ['HiddenPowerType', 'FirstCurrentType', 'TeraType',
			'HeldPlate', 'HeldMemory', 'HeldDrive', 'NaturalGift'], field('Source'));
		const fallback = fields.DefaultType === undefined ? undefined : string(fields.DefaultType, field('DefaultType'));
		const skipZ = fields.ExcludeZCrystals === undefined ? false : bool(fields.ExcludeZCrystals, field('ExcludeZCrystals'));
		const fallbackSecond = fields.FallbackToSecondType === undefined ? false :
			bool(fields.FallbackToSecondType, field('FallbackToSecondType'));
		if (fields.ExcludeZCrystals !== undefined && source !== 'HeldPlate') invalid(field('ExcludeZCrystals'), 'expected a held plate');
		if (fields.FallbackToSecondType !== undefined && source !== 'FirstCurrentType') {
			invalid(field('FallbackToSecondType'), 'expected the current Pokémon type');
		}
		const applies = when();
		const previous = move.onModifyType;
		move.onModifyType = function (activeMove, user, target) {
			previous?.call(this, activeMove, user, target);
			if (!applies(this, user, target, activeMove)) return;
			if (source === 'HiddenPowerType') {
				activeMove.type = user.hpType || fallback || activeMove.type;
				return;
			}
			if (source === 'TeraType') {
				if (user.terastallized) activeMove.type = user.teraType;
				return;
			}
			if (source === 'FirstCurrentType') {
				const [first, second] = user.getTypes();
				const type = first === 'Bird' ? '???' : first;
				activeMove.type = type === '???' && fallbackSecond && second ? second : type;
				return;
			}
			if (user.ignoringItem()) return;
			const item = user.getItem();
			if (source === 'HeldMemory' || source === 'HeldDrive') {
				activeMove.type = this.runEvent(source === 'HeldMemory' ? 'Memory' : 'Drive', user, null, activeMove, fallback ?? activeMove.type);
			} else if (source === 'HeldPlate') {
				if (!skipZ || !item.zMove) activeMove.type = item.onPlate || fallback || activeMove.type;
			} else if (item.naturalGift) {
				activeMove.type = item.naturalGift.type;
			}
		};
		break;
	}
	case 'UseHeldItemMoveData': {
		keys('Source', 'ApplyAt', 'ConsumeItem', 'FailWithoutItemData');
		choice(fields.Source, ['NaturalGift'], field('Source'));
		choice(fields.ApplyAt, ['PrepareHit'], field('ApplyAt'));
		const consume = bool(fields.ConsumeItem, field('ConsumeItem'));
		const fail = bool(fields.FailWithoutItemData, field('FailWithoutItemData'));
		if (move.onPrepareHit) invalid(path, 'item data conflicts with another preparation effect');
		move.onPrepareHit = function (_target, user, activeMove) {
			const item = user.getItem();
			if (user.ignoringItem() || !item.naturalGift) return fail ? false : undefined;
			activeMove.basePower = item.naturalGift.basePower;
			if (consume) {
				user.setItem('');
				user.lastItem = item.id;
				user.usedItemThisTurn = true;
				this.runEvent('AfterUseItem', user, null, null, item);
			}
		};
		break;
	}
	case 'ModifyPriority': {
		keys('Delta', 'Requirements');
		const amount = integer(fields.Delta, field('Delta'), -Number.MAX_SAFE_INTEGER);
		const applies = when();
		const previous = move.onModifyPriority;
		move.onModifyPriority = function (priority, user, target, activeMove) {
			const result = previous?.call(this, priority, user, target, activeMove) ?? priority;
			return applies(this, user, target, activeMove) ? result + amount : result;
		};
		break;
	}
	case 'ChangeCategoryByOffensiveStats': {
		keys('PrimaryStat', 'ComparedStat', 'HigherCategory', 'IgnoreStatModifiers', 'Requirements');
		const primary = lookup(fields.PrimaryStat, stats, field('PrimaryStat'));
		const compared = lookup(fields.ComparedStat, stats, field('ComparedStat'));
		const category = choice(fields.HigherCategory, ['Physical', 'Special'], field('HigherCategory'));
		const unmodified = fields.IgnoreStatModifiers === undefined ? false : bool(fields.IgnoreStatModifiers, field('IgnoreStatModifiers'));
		const applies = when();
		const previous = move.onModifyMove;
		move.onModifyMove = function (activeMove, user, target) {
			previous?.call(this, activeMove, user, target);
			if (applies(this, user, target, activeMove) && user.getStat(primary, false, unmodified) > user.getStat(compared, false, unmodified)) {
				activeMove.category = category;
			}
		};
		break;
	}
	case 'RequireConditions': {
		keys('ApplyAt', 'Requirements', 'DisableWhenUnmet');
		const at = choice(fields.ApplyAt, ['TryMove', 'TryMoveEvent', 'TryHit', 'TryImmunity', 'Hit'], field('ApplyAt'));
		const rules = list(fields.Requirements, field('Requirements'));
		const applies = requirements(rules, field('Requirements'));
		const first = rules.length === 1 ? object(rules[0], `${field('Requirements')}[0]`) : undefined;
		const choices = first?.Type === 'AnyOf' ? list(first.Requirements, field('Requirements[0].Requirements')) : rules;
		const speciesRule = choices.map((rule, index) => object(rule, `${field('Requirements')}[${index}]`))
			.find(rule => rule.Subject === 'User' && (rule.Type === 'HasSpeciesForm' || rule.Type === 'HasBaseSpecies'));
		const speciesGate = speciesRule ?
			{ type: speciesRule.Type, id: string(speciesRule.SpeciesId, field('Requirements.SpeciesId')) } : undefined;
		if (fields.DisableWhenUnmet !== undefined && bool(fields.DisableWhenUnmet, field('DisableWhenUnmet'))) {
			const previous = move.onDisableMove;
			move.onDisableMove = function (pokemon) {
				previous?.call(this, pokemon);
				const activeMove = this.dex.getActiveMove(move.name);
				if (!applies(this, pokemon, null, activeMove)) pokemon.disableMove(activeMove.id);
			};
		}
		if (at === 'TryMove' || at === 'TryMoveEvent') {
			const previous = move.onTryMove;
			move.onTryMove = function (user, target, activeMove) {
				if (!applies(this, user, target, activeMove)) {
					this.attrLastMove('[still]');
					if (speciesGate) {
						const wanted = this.dex.species.get(speciesGate.id);
						const wrongForm = speciesGate.type === 'HasSpeciesForm' && user.species.name === wanted.baseSpecies;
						if (wrongForm) this.add('-fail', user, `move: ${activeMove.name}`, '[forme]');
						else this.add('-fail', user, `move: ${activeMove.name}`);
					} else if (at === 'TryMoveEvent') {
						this.add('-fail', user, `move: ${activeMove.name}`);
						return null;
					} else {
						this.add('-fail', user);
					}
					return false;
				}
				return typeof previous === 'function' ? previous.call(this, user, target, activeMove) : previous;
			};
		} else if (at === 'TryHit') {
			const previous = move.onTryHit;
			move.onTryHit = function (target, user, activeMove) {
				if (!applies(this, user, target, activeMove)) return false;
				return typeof previous === 'function' ? previous.call(this, target, user, activeMove) : previous;
			};
		} else if (at === 'Hit') {
			const previous = move.onHit;
			move.onHit = function (target, user, activeMove) {
				if (!applies(this, user, target, activeMove)) {
					if (activeMove.selfSwitch !== 'copyvolatile') return false;
					this.attrLastMove('[still]');
					this.add('-fail', target);
					return this.NOT_FAIL;
				}
				return typeof previous === 'function' ? previous.call(this, target, user, activeMove) : previous;
			};
		} else {
			const previous = move.onTryImmunity;
			move.onTryImmunity = function (target, user, activeMove) {
				if (!applies(this, user, target, activeMove)) return false;
				return typeof previous === 'function' ? previous.call(this, target, user, activeMove) : previous;
			};
		}
		break;
	}
	default:
		invalid(field('Type'), `unsupported mechanic ${String(fields.Type)}`);
	}
}

function stageChanges(value: unknown, path: string): SparseBoostsTable {
	const result: SparseBoostsTable = {};
	for (const [key, delta] of Object.entries(object(value, path))) {
		result[lookup(key, stages, path)] = integer(delta, `${path}.${key}`, -6, 6);
	}
	return result;
}

function entryHazard(effect: Fields, path: string): string {
	const condition = choice(effect.ConditionId, ['spikes', 'stealthrock', 'stickyweb', 'toxicspikes'], `${path}.ConditionId`);
	const keys = (...fields: string[]) => object(effect, path, ['Type', 'ConditionId', 'IgnoredWithItemId', ...fields]);
	choice(effect.IgnoredWithItemId, ['heavydutyboots'], `${path}.IgnoredWithItemId`);
	if (condition === 'stealthrock') {
		keys('DamageByMoveType', 'DamageFraction', 'HPBasis');
		choice(effect.DamageByMoveType, ['Rock'], `${path}.DamageByMoveType`);
		choice(effect.HPBasis, ['MaxHP'], `${path}.HPBasis`);
		nativeFraction(effect.DamageFraction, `${path}.DamageFraction`, 1, 8);
	} else {
		nativeBoolean(effect.RequiresGrounded, `${path}.RequiresGrounded`, true);
		if (condition === 'spikes') {
			keys('RequiresGrounded', 'DamageByLayer', 'HPBasis');
			choice(effect.HPBasis, ['MaxHP'], `${path}.HPBasis`);
			const layers = list(effect.DamageByLayer, `${path}.DamageByLayer`);
			if (layers.length !== 3) invalid(`${path}.DamageByLayer`, 'the spikes condition has three layers');
			[8, 6, 4].forEach((denominator, index) =>
				nativeFraction(layers[index], `${path}.DamageByLayer[${index}]`, 1, denominator));
		} else if (condition === 'stickyweb') {
			keys('RequiresGrounded', 'Effect');
			const changes = object(effect.Effect, `${path}.Effect`, ['Type', 'Stages']);
			choice(changes.Type, ['ChangeStats'], `${path}.Effect.Type`);
			const speed = object(changes.Stages, `${path}.Effect.Stages`, ['Speed']);
			integer(speed.Speed, `${path}.Effect.Stages.Speed`, -1, -1);
		} else {
			keys('RequiresGrounded', 'RemovedByPokemonTypes', 'ImmunePokemonTypes', 'StatusByLayer');
			for (const [field, expected] of [
				['RemovedByPokemonTypes', ['Poison']], ['ImmunePokemonTypes', ['Steel']], ['StatusByLayer', ['Poison', 'BadPoison']],
			] as const) {
				const values = strings(effect[field], `${path}.${field}`);
				if (values.length !== expected.length || expected.some((item, i) => item !== values[i])) {
					invalid(`${path}.${field}`, `the toxic spikes condition uses ${expected.join(', ')}`);
				}
			}
		}
	}
	return condition;
}

function damageScreen(effect: Fields, path: string): string {
	object(effect, path, ['Type', 'ConditionId', 'DurationTurns', 'DurationOverrides', 'DamageCategories', 'DamageMultiplier',
		'OverlappingScreens', 'BypassedByCriticalHit', 'BypassedByInfiltration', 'ExcludeSelfDamage', 'ApplyToAlliedSides']);
	const id = choice(effect.ConditionId, ['reflect', 'lightscreen', 'auroraveil'], `${path}.ConditionId`);
	integer(effect.DurationTurns, `${path}.DurationTurns`, 5, 5);
	const overrides = list(effect.DurationOverrides, `${path}.DurationOverrides`);
	if (overrides.length !== 1) invalid(`${path}.DurationOverrides`, 'the selected condition only checks Light Clay');
	const lightClay = object(overrides[0], `${path}.DurationOverrides[0]`, ['Requirements', 'DurationTurns']);
	integer(lightClay.DurationTurns, `${path}.DurationOverrides[0].DurationTurns`, 8, 8);
	const requirements = list(lightClay.Requirements, `${path}.DurationOverrides[0].Requirements`);
	if (requirements.length !== 1) invalid(`${path}.DurationOverrides[0].Requirements`, 'expected one Light Clay check');
	const itemPath = `${path}.DurationOverrides[0].Requirements[0]`;
	const item = object(requirements[0], itemPath, ['Type', 'Subject', 'ItemId']);
	choice(item.Type, ['HasHeldItem'], `${itemPath}.Type`);
	choice(item.Subject, ['User'], `${itemPath}.Subject`);
	choice(item.ItemId, ['lightclay'], `${itemPath}.ItemId`);
	nativeOptions(effect.DamageCategories, `${path}.DamageCategories`,
		id === 'auroraveil' ? ['Physical', 'Special'] : id === 'reflect' ? ['Physical'] : ['Special']);
	const ratio = object(effect.DamageMultiplier, `${path}.DamageMultiplier`, ['Singles', 'MultipleActiveSlotsPerSide']);
	nativeFraction(ratio.Singles, `${path}.DamageMultiplier.Singles`, 1, 2);
	nativeFraction(ratio.MultipleActiveSlotsPerSide, `${path}.DamageMultiplier.MultipleActiveSlotsPerSide`, 2732, 4096);
	if (id === 'auroraveil' || 'OverlappingScreens' in effect) {
		const overlap = list(effect.OverlappingScreens, `${path}.OverlappingScreens`);
		const screens = overlap.map((entry, index) => {
			const slot = `${path}.OverlappingScreens[${index}]`;
			const screen = object(entry, slot, ['ConditionId', 'Category']);
			return string(screen.ConditionId, `${slot}.ConditionId`) + ':' + string(screen.Category, `${slot}.Category`);
		});
		nativeOptions(screens, `${path}.OverlappingScreens`, id === 'auroraveil' ? ['reflect:Physical', 'lightscreen:Special'] : []);
	}
	for (const property of ['BypassedByCriticalHit', 'BypassedByInfiltration', 'ExcludeSelfDamage', 'ApplyToAlliedSides']) {
		nativeBoolean(effect[property], `${path}.${property}`, true);
	}
	return id;
}

function fieldRule(effect: Fields, path: string): string {
	object(effect, path, ['Type', 'ConditionId', 'Rule', 'DurationTurns', 'ToggleOffOnRepeat', 'DurationOverride',
		'ResidualOrder', 'ResidualSubOrder']);
	const id = choice(effect.ConditionId, ['trickroom', 'wonderroom'], `${path}.ConditionId`);
	choice(effect.Rule, id === 'trickroom' ? ['ReverseSpeedOrder'] : ['SwapDefenseForDamageCalculations'], `${path}.Rule`);
	integer(effect.DurationTurns, `${path}.DurationTurns`, 5, 5);
	nativeBoolean(effect.ToggleOffOnRepeat, `${path}.ToggleOffOnRepeat`, true);
	const override = object(effect.DurationOverride, `${path}.DurationOverride`, ['AbilityId', 'DurationTurns']);
	choice(override.AbilityId, ['persistent'], `${path}.DurationOverride.AbilityId`);
	integer(override.DurationTurns, `${path}.DurationOverride.DurationTurns`, 7, 7);
	integer(effect.ResidualOrder, `${path}.ResidualOrder`, 27, 27);
	const order = id === 'trickroom' ? 1 : 5;
	integer(effect.ResidualSubOrder, `${path}.ResidualSubOrder`, order, order);
	return id;
}

function typeChange(effect: Fields, path: string): NativeHitEffect {
	object(effect, path, ['Type', 'Recipient', 'TypeSource', 'FailIfTypeUnchanged', 'FailIfAlreadyHasType']);
	const recipient = choice(effect.Recipient, ['User', 'Target'], `${path}.Recipient`);
	const location = `${path}.TypeSource`;
	const source = object(effect.TypeSource, location);
	const kind = choice(source.Type, ['Terrain', 'MoveSlot', 'TypeChartAgainstLastMove'], `${location}.Type`);
	const same = effect.FailIfTypeUnchanged === undefined ? false : bool(effect.FailIfTypeUnchanged, `${path}.FailIfTypeUnchanged`);
	const has = effect.FailIfAlreadyHasType === undefined ? false : bool(effect.FailIfAlreadyHasType, `${path}.FailIfAlreadyHasType`);
	let findType: (battle: Battle, pokemon: Pokemon, target: Pokemon, user: Pokemon) => string | undefined;
	if (kind === 'Terrain') {
		object(source, location, ['Type', 'DefaultType', 'Overrides']);
		const fallback = string(source.DefaultType, `${location}.DefaultType`);
		const overrides = new Map<string, string>();
		for (const [index, entry] of list(source.Overrides, `${location}.Overrides`).entries()) {
			const itemPath = `${location}.Overrides[${index}]`;
			const item = object(entry, itemPath, ['Terrain', 'PokemonType']);
			overrides.set(string(item.Terrain, `${itemPath}.Terrain`), string(item.PokemonType, `${itemPath}.PokemonType`));
		}
		findType = battle => [...overrides].find(([terrain]) => battle.field.isTerrain(terrain))?.[1] ?? fallback;
	} else if (kind === 'MoveSlot') {
		object(source, location, ['Type', 'Subject', 'SlotNumber']);
		const subject = activePokemon(source.Subject, `${location}.Subject`);
		const slot = integer(source.SlotNumber, `${location}.SlotNumber`, 1, 4) - 1;
		findType = (battle, _pokemon, target, user) => {
			const move = subject(user, target).moveSlots[slot];
			return move ? battle.dex.moves.get(move.id).type : undefined;
		};
	} else {
		object(source, location, ['Type', 'Subject', 'Match', 'ExcludeCurrentTypes']);
		const subject = activePokemon(source.Subject, `${location}.Subject`);
		const kinds = new Map([['Resistant', 2], ['Immune', 3], ['Weak', 1], ['Neutral', 0]]);
		const matches = list(source.Match, `${location}.Match`).map(kind => lookup(kind, kinds, `${location}.Match`));
		const exclude = bool(source.ExcludeCurrentTypes, `${location}.ExcludeCurrentTypes`);
		findType = (battle, pokemon, target, user) => {
			const attack = subject(user, target).lastMoveUsed;
			if (!attack) return;
			const types = battle.dex.types.names().filter(type => (!exclude || !pokemon.hasType(type)) &&
				matches.includes(battle.dex.types.get(type).damageTaken[attack.type] ?? 0));
			return types.length ? battle.sample(types) : undefined;
		};
	}
	return { onHit(target, user) {
		const pokemon = recipient === 'User' ? user : target;
		const type = findType(this, pokemon, target, user);
		if (!type || (same && pokemon.getTypes().join() === type) || (has && pokemon.hasType(type)) || !pokemon.setType(type)) {
			return false;
		}
		this.add('-start', pokemon, 'typechange', type);
	} };
}

function applyPrimaryEffect(move: MoveData, value: unknown) {
	const path = 'Battle.PrimaryEffect';
	const effect = object(value, path);
	if (typeof effect.Type === 'string' && ['CallRandomPartyMove', 'CallRandomKnownMove', 'CallRandomCatalogMove', 'CallPreviousMove'].includes(effect.Type)) {
		move.callsMove = true;
		move.onHit = compileMoveCall(effect, path);
		return;
	}
	if (effect.Type === 'CopyAbility') {
		attachAbilityCopy(move, effect, path);
		return;
	}
	if (effect.Type === 'TransferMajorStatus') {
		object(effect, path, ['Type', 'From', 'To', 'CureSourceOnSuccess']);
		choice(effect.From, ['User'], `${path}.From`);
		choice(effect.To, ['Target'], `${path}.To`);
		const cure = bool(effect.CureSourceOnSuccess, `${path}.CureSourceOnSuccess`);
		move.onTryHit = function (_target, user, activeMove) {
			if (!user.status) return false;
			activeMove.status = user.status;
		};
		if (cure) move.self = { onHit(user) { user.cureStatus(); } };
		return;
	}
	if (effect.Type === 'EatUserBerryAfterBoost') {
		object(effect, path, ['Type', 'Boost', 'DisableMoveWithoutBerry']);
		const apply = eventEffect(effect.Boost, `${path}.Boost`);
		const disable = bool(effect.DisableMoveWithoutBerry, `${path}.DisableMoveWithoutBerry`);
		move.onTry = function (user) { return user.getItem().isBerry; };
		if (disable) {
			move.onDisableMove = function (pokemon) { if (!pokemon.getItem().isBerry) pokemon.disableMove(move.name); };
		}
		move.onHit = function (target, user, activeMove) {
			if (!apply(this, target, user, activeMove)) return null;
			target.eatItem(true);
		};
		return;
	}
	if (effect.Type === 'RequestRevival') {
		object(effect, path, ['Type', 'ConditionId', 'DurationTurns', 'Fraction']);
		move.slotCondition = choice(effect.ConditionId, ['revivalblessing'], `${path}.ConditionId`);
		integer(effect.DurationTurns, `${path}.DurationTurns`, 1, 1);
		nativeFraction(effect.Fraction, `${path}.Fraction`, 1, 2);
		move.selfSwitch = true;
		return;
	}
	if (effect.Type === 'TrapAndLowerStats' && nativeCondition(effect, path)) {
		move.onTryImmunity = function (target) { return this.dex.getImmunity('trapped', target); };
	}
	if (effect.Type === 'Sequence') {
		const parts = list(effect.Effects, `${path}.Effects`).map((entry, i) => object(entry, `${path}.Effects[${i}]`));
		const boost = parts.find(part => part.Type === 'BoostNextMoveOfType');
		if (boost) attachOutgoingBoost(move, boost, path);
	}
	if (effect.Type !== 'CreateSubstitute') {
		Object.assign(move, hitEffect(effect, path));
		return;
	}
	object(effect, path, ['Type', 'ConditionId', 'CostFraction', 'DecoyHPFraction', 'CostRounding']);
	const id = choice(effect.ConditionId, ['substitute'], `${path}.ConditionId`);
	const [n, d] = fraction(effect.CostFraction, `${path}.CostFraction`);
	nativeFraction(effect.DecoyHPFraction, `${path}.DecoyHPFraction`, 1, 4);
	const roundUp = effect.CostRounding !== undefined &&
		choice(effect.CostRounding, ['Ceiling'], `${path}.CostRounding`) === 'Ceiling';
	const cost = (pokemon: Pokemon) => roundUp ? Math.ceil(pokemon.maxhp * n / d) : pokemon.maxhp * n / d;
	move.volatileStatus = id;
	move.onTryHit = function (pokemon) {
		if (pokemon.volatiles[id]) {
			this.add('-fail', pokemon, 'move: Substitute');
			return this.NOT_FAIL;
		}
		if (pokemon.hp <= cost(pokemon) || pokemon.maxhp === 1) {
			this.add('-fail', pokemon, 'move: Substitute', '[weak]');
			return this.NOT_FAIL;
		}
	};
	move.onHit = function (pokemon) { this.directDamage(cost(pokemon), pokemon); };
}

function publishedMoveId(battle: Battle, id: string): string {
	const translated = battle.dex.moves.get('nomelat' + id);
	return translated.exists ? translated.id : id;
}

function compileMoveCall(effect: Fields, path: string): NonNullable<MoveData['onHit']> {
	const keys = (...names: string[]) => object(effect, path, ['Type', ...names]);
	if (effect.Type === 'CallRandomCatalogMove') {
		keys('RequiredFlag', 'IncludeUnobtainable', 'SortByMoveNumber');
		const flag = string(effect.RequiredFlag, `${path}.RequiredFlag`);
		const unobtainable = bool(effect.IncludeUnobtainable, `${path}.IncludeUnobtainable`);
		const sort = bool(effect.SortByMoveNumber, `${path}.SortByMoveNumber`);
		return function (user) {
			const moves = this.dex.moves.all().filter(move => !move.id.startsWith('nomelat') &&
				(!move.isNonstandard || (unobtainable && move.isNonstandard === 'Unobtainable')) &&
				move.flags[flag as keyof typeof move.flags]);
			if (!moves.length) return false;
			if (sort) moves.sort((a, b) => a.num - b.num);
			this.actions.useMove(publishedMoveId(this, this.sample(moves).id), user);
		};
	}

	const flags = strings(effect.ExcludedFlags, `${path}.ExcludedFlags`);
	const max = bool(effect.ExcludeMaxMoves, `${path}.ExcludeMaxMoves`);
	const barred = (move: Move | ActiveMove) => (max && move.isMax) || flags.some(flag => move.flags[flag as keyof typeof move.flags]);
	if (effect.Type === 'CallPreviousMove') {
		keys('Source', 'ExcludedFlags', 'ExcludeZMoves', 'ExcludeMaxMoves', 'UseMaxBaseMove');
		choice(effect.Source, ['BattleLastMove'], `${path}.Source`);
		const z = bool(effect.ExcludeZMoves, `${path}.ExcludeZMoves`);
		const base = bool(effect.UseMaxBaseMove, `${path}.UseMaxBaseMove`);
		return function (user) {
			let previous: Move | ActiveMove | null = this.lastMove;
			if (!previous) return;
			if (base && previous.isMax && previous.baseMove) previous = this.dex.moves.get(previous.baseMove);
			if ((z && previous.isZ) || barred(previous)) return false;
			this.actions.useMove(previous.id, user);
		};
	}
	if (effect.Type === 'CallRandomKnownMove') {
		keys('ExcludedFlags', 'ExcludeMaxMoves', 'OnlyStatusZMoves');
		const statusZ = bool(effect.OnlyStatusZMoves, `${path}.OnlyStatusZMoves`);
		return function (user) {
			const moves = user.moveSlots.map(slot => this.dex.moves.get(slot.id)).filter(move =>
				move.exists && !barred(move) && (!statusZ || !move.isZ || move.basePower === 1));
			if (!moves.length) return false;
			this.actions.useMove(this.sample(moves).id, user);
		};
	}
	keys('ExcludeUser', 'IncludeFainted', 'KeepDuplicates', 'ExcludedFlags', 'ExcludeZMoves', 'ExcludeMaxMoves');
	const exclude = bool(effect.ExcludeUser, `${path}.ExcludeUser`);
	const fainted = bool(effect.IncludeFainted, `${path}.IncludeFainted`);
	const duplicates = bool(effect.KeepDuplicates, `${path}.KeepDuplicates`);
	const z = bool(effect.ExcludeZMoves, `${path}.ExcludeZMoves`);
	return function (user) {
		let moves = user.side.pokemon.filter(pokemon => (!exclude || pokemon !== user) && (fainted || !pokemon.fainted))
			.flatMap(pokemon => pokemon.moveSlots.map(slot => this.dex.moves.get(slot.id)))
			.filter(move => move.exists && (!z || !move.isZ) && !barred(move)).map(move => move.id);
		if (!duplicates) moves = [...new Set(moves)];
		if (!moves.length) return false;
		this.actions.useMove(this.sample(moves), user);
	};
}

function attachOutgoingBoost(move: MoveData, fields: Fields, path: string) {
	const id = choice(fields.ConditionId, ['charge'], `${path}.ConditionId`);
	const moveType = string(fields.MoveType, `${path}.MoveType`);
	const multiplier = numeric(fields.Multiplier, `${path}.Multiplier`);
	const priority = integer(fields.Priority, `${path}.Priority`, -Number.MAX_SAFE_INTEGER);
	const consume = bool(fields.ConsumeOnUse, `${path}.ConsumeOnUse`);
	const aborted = bool(fields.ConsumeOnAbortedUse, `${path}.ConsumeOnAbortedUse`);
	const ignore = bool(fields.IgnoreApplyingMove, `${path}.IgnoreApplyingMove`);
	const name = id.charAt(0).toUpperCase() + id.slice(1);
	const key = toID(move.name);
	const consumeAfter = (pokemon: Pokemon, used: ActiveMove) => {
		if (used.type === moveType && (!ignore || used.id !== key)) pokemon.removeVolatile(key);
	};
	move.condition = {
		onStart(target) { this.add('-start', target, name); },
		onRestart(target) { this.add('-start', target, name); },
		onBasePowerPriority: priority,
		onBasePower(_base, _attacker, _defender, used) {
			if (used.type === moveType) return this.chainModify(multiplier);
		},
		onAfterMove(pokemon, _target, used) { if (consume) consumeAfter(pokemon, used); },
		onMoveAborted(pokemon, _target, used) { if (aborted) consumeAfter(pokemon, used); },
		onEnd(target) { this.add('-end', target, name, '[silent]'); },
	};
}

function attachAbilityCopy(move: MoveData, effect: Fields, path: string) {
	object(effect, path, ['Type', 'From', 'Selection', 'BlockedSourceFlags', 'BlockedRecipientFlags', 'BlockedRecipientAbilities',
		'FailIfSameAbility', 'RequireAtLeastOneChange', 'MarkExternalOnFoes']);
	const from = activePokemon(effect.From, `${path}.From`);
	const selected = choice(effect.Selection, ['User', 'Target', 'UserAndActiveAllies'], `${path}.Selection`);
	const sourceFlags = effect.BlockedSourceFlags === undefined ? [] : strings(effect.BlockedSourceFlags, `${path}.BlockedSourceFlags`);
	const destinationFlags = effect.BlockedRecipientFlags === undefined ? [] :
		strings(effect.BlockedRecipientFlags, `${path}.BlockedRecipientFlags`);
	const exceptions = effect.BlockedRecipientAbilities === undefined ? [] :
		strings(effect.BlockedRecipientAbilities, `${path}.BlockedRecipientAbilities`);
	const requireDifferent = effect.FailIfSameAbility === undefined ? false : bool(effect.FailIfSameAbility, `${path}.FailIfSameAbility`);
	const requireChange = effect.RequireAtLeastOneChange === undefined ? false : bool(effect.RequireAtLeastOneChange, `${path}.RequireAtLeastOneChange`);
	const mark = effect.MarkExternalOnFoes === undefined ? false : bool(effect.MarkExternalOnFoes, `${path}.MarkExternalOnFoes`);
	const blocked = (pokemon: Pokemon, flags: string[]) => {
		const data = pokemon.getAbility().flags;
		return flags.some(flag => data[flag as keyof typeof data]);
	};
	const eligible = (source: Pokemon, dest: Pokemon) => !exceptions.includes(dest.ability) &&
		!blocked(dest, destinationFlags) && (!requireDifferent || source.ability !== dest.ability);
	if (selected !== 'UserAndActiveAllies') {
		const to = activePokemon(selected, `${path}.Selection`);
		move.onTryHit = function (target, user) {
			const source = from(user, target);
			if (blocked(source, sourceFlags) || !eligible(source, to(user, target))) return false;
		};
		move.onHit = function (target, user) {
			const source = from(user, target);
			const dest = to(user, target);
			const old = dest.setAbility(source.ability, source);
			if (old === false || old === null) return old;
			if (!old) return;
			if (mark && !dest.isAlly(source)) dest.volatileStaleness = 'external';
		};
	} else {
		move.onHit = function (target, user, activeMove) {
			const source = from(user, target);
			let outcome: boolean | null = false;
			if (!blocked(source, sourceFlags)) {
				for (const ally of user.alliesAndSelf()) {
					if (!eligible(source, ally)) continue;
					const old = ally.setAbility(source.ability, null, activeMove);
					if (old) outcome = true;
					else if (!outcome && old === null) outcome = null;
				}
			}
			if (requireChange && !outcome) {
				if (outcome === false) this.add('-fail', user);
				this.attrLastMove('[still]');
				return this.NOT_FAIL;
			}
		};
	}
}
function hitEffect(value: unknown, path: string): NativeHitEffect {
	const effect = object(value, path);
	switch (effect.Type) {
	case 'ChangePokemonType':
		return typeChange(effect, path);
	case 'GroundTarget': {
		object(effect, path, ['Type', 'ConditionId', 'CanBeCopied', 'AirbornePokemonTypes', 'AirborneAbilities',
			'AlreadyGroundedWithItems', 'AlreadyGroundedWithVolatiles', 'AlreadyGroundedWithFieldConditions',
			'CancelChargeVolatiles', 'EndOnGroundingVolatiles', 'ClearChargeId']);
		const id = choice(effect.ConditionId, ['smackdown'], `${path}.ConditionId`);
		nativeBoolean(effect.CanBeCopied, `${path}.CanBeCopied`, false);
		choice(effect.ClearChargeId, ['twoturnmove'], `${path}.ClearChargeId`);
		for (const [field, expected] of Object.entries({
			AirbornePokemonTypes: ['Flying'], AirborneAbilities: ['levitate', 'eelevate'], AlreadyGroundedWithItems: ['ironball'],
			AlreadyGroundedWithVolatiles: ['ingrain'], AlreadyGroundedWithFieldConditions: ['gravity'],
			CancelChargeVolatiles: ['fly', 'bounce'], EndOnGroundingVolatiles: ['magnetrise', 'telekinesis'],
		})) {
			nativeOptions(effect[field], `${path}.${field}`, expected);
		}
		return { volatileStatus: id };
	}
	case 'ExposeTarget': {
		object(effect, path, ['Type', 'ConditionId', 'CanBeCopied', 'ImmunityTargetType', 'NegateImmunityTo', 'RemovePositiveEvasion']);
		const id = choice(effect.ConditionId, ['foresight'], `${path}.ConditionId`);
		nativeBoolean(effect.CanBeCopied, `${path}.CanBeCopied`, false);
		choice(effect.ImmunityTargetType, ['Ghost'], `${path}.ImmunityTargetType`);
		nativeOptions(effect.NegateImmunityTo, `${path}.NegateImmunityTo`, ['Normal', 'Fighting']);
		nativeBoolean(effect.RemovePositiveEvasion, `${path}.RemovePositiveEvasion`, true);
		return { volatileStatus: id };
	}
	case 'ApplyCriticalRatioBoost': {
		object(effect, path, ['Type', 'ConditionId', 'Stages', 'BlockedByVolatile', 'Bonus']);
		const id = choice(effect.ConditionId, ['focusenergy', 'dragoncheer'], `${path}.ConditionId`);
		const dragon = id === 'dragoncheer';
		choice(effect.BlockedByVolatile, dragon ? ['focusenergy'] : ['dragoncheer'], `${path}.BlockedByVolatile`);
		integer(effect.Stages, `${path}.Stages`, dragon ? 1 : 2, dragon ? 1 : 2);
		if (dragon) {
			const bonus = object(effect.Bonus, `${path}.Bonus`, ['PokemonType', 'Stages', 'EvaluateOnStart']);
			choice(bonus.PokemonType, ['Dragon'], `${path}.Bonus.PokemonType`);
			integer(bonus.Stages, `${path}.Bonus.Stages`, 1, 1);
			nativeBoolean(bonus.EvaluateOnStart, `${path}.Bonus.EvaluateOnStart`, true);
		} else if ('Bonus' in effect) {
			invalid(`${path}.Bonus`, 'the selected condition has no type bonus');
		}
		return { volatileStatus: id };
	}
	case 'RedirectFoeMoves': {
		object(effect, path, ['Type', 'ConditionId', 'DurationTurns', 'Priority', 'SkipIfSkyDropped',
			'DisableSmartTarget', 'RespectTargetRange', 'RequiresSourceSusceptibleToPowder']);
		const id = choice(effect.ConditionId, ['followme', 'ragepowder'], `${path}.ConditionId`);
		integer(effect.DurationTurns, `${path}.DurationTurns`, 1, 1);
		integer(effect.Priority, `${path}.Priority`, 1, 1);
		for (const field of ['SkipIfSkyDropped', 'DisableSmartTarget', 'RespectTargetRange']) {
			nativeBoolean(effect[field], `${path}.${field}`, true);
		}
		if (id === 'ragepowder' || 'RequiresSourceSusceptibleToPowder' in effect) {
			nativeBoolean(effect.RequiresSourceSusceptibleToPowder, `${path}.RequiresSourceSusceptibleToPowder`, id === 'ragepowder');
		}
		return { volatileStatus: id };
	}
	case 'LockAccuracyOnTarget': {
		object(effect, path, ['Type', 'ConditionId', 'DurationTurns', 'CanBeCopied', 'InvulnerabilityPriority']);
		const id = choice(effect.ConditionId, ['lockon'], `${path}.ConditionId`);
		integer(effect.DurationTurns, `${path}.DurationTurns`, 2, 2);
		nativeBoolean(effect.CanBeCopied, `${path}.CanBeCopied`, false);
		integer(effect.InvulnerabilityPriority, `${path}.InvulnerabilityPriority`, 1, 1);
		return { onHit(target, user, move) {
			user.addVolatile(id, target);
			this.add('-activate', user, `move: ${move.name}`, `[of] ${target}`);
		} };
	}
	case 'RemovePokemonType': {
		object(effect, path, ['Type', 'PokemonType']);
		const removed = string(effect.PokemonType, `${path}.PokemonType`);
		return { onHit(pokemon, _user, move) {
			pokemon.setType(pokemon.getTypes(true).map(type => type === removed ? '???' : type));
			this.add('-start', pokemon, 'typechange', pokemon.getTypes().join('/'), `[from] move: ${move.name}`);
		} };
	}
	case 'ReplacePokemonType': {
		object(effect, path, ['Type', 'PokemonType', 'FailsIfAlreadyMonoType', 'AnimateOnFailure']);
		const type = string(effect.PokemonType, `${path}.PokemonType`);
		const fails = bool(effect.FailsIfAlreadyMonoType, `${path}.FailsIfAlreadyMonoType`);
		const animate = effect.AnimateOnFailure === undefined ? false : bool(effect.AnimateOnFailure, `${path}.AnimateOnFailure`);
		return { onHit(target) {
			if ((fails && target.getTypes().join() === type) || !target.setType(type)) {
				if (!animate) return false;
				this.add('-fail', target);
				return null;
			}
			this.add('-start', target, 'typechange', type);
		} };
	}
	case 'AddPokemonType': {
		object(effect, path, ['Type', 'PokemonType', 'FailsIfPresent', 'QueuedMoveRetarget']);
		const type = string(effect.PokemonType, `${path}.PokemonType`);
		const fails = bool(effect.FailsIfPresent, `${path}.FailsIfPresent`);
		const retarget = effect.QueuedMoveRetarget === undefined ? undefined : object(effect.QueuedMoveRetarget,
			`${path}.QueuedMoveRetarget`, ['MoveId', 'ActiveSlotsPerSide', 'TargetPosition', 'TargetLocation']);
		const queue = !retarget ? undefined : {
			id: string(retarget.MoveId, `${path}.QueuedMoveRetarget.MoveId`),
			slots: integer(retarget.ActiveSlotsPerSide, `${path}.QueuedMoveRetarget.ActiveSlotsPerSide`, 1),
			position: integer(retarget.TargetPosition, `${path}.QueuedMoveRetarget.TargetPosition`),
			target: integer(retarget.TargetLocation, `${path}.QueuedMoveRetarget.TargetLocation`, -Number.MAX_SAFE_INTEGER),
		};
		return { onHit(target, _user, move) {
			if ((fails && target.hasType(type)) || !target.addType(type)) return false;
			this.add('-start', target, 'typeadd', type, `[from] move: ${move.name}`);
			if (queue && target.side.active.length === queue.slots && target.position === queue.position) {
				const action = this.queue.willMove(target);
				if (action?.choice === 'move' && action.move.id === queue.id) action.targetLoc = queue.target;
			}
		} };
	}
	case 'ChangeStats':
		object(effect, path, ['Type', 'Stages']);
		return { boosts: stageChanges(effect.Stages, `${path}.Stages`) };
	case 'ApplyStatus':
		object(effect, path, ['Type', 'Status']);
		return { status: lookup(effect.Status, statuses, `${path}.Status`) };
	case 'ApplyVolatile':
		object(effect, path, ['Type', 'Condition']);
		return { volatileStatus: string(effect.Condition, `${path}.Condition`) };
	case 'ApplyResidualHealing': {
		object(effect, path, ['Type', 'ConditionId', 'Fraction', 'ResidualOrder', 'PreventVoluntarySwitch', 'PreventForcedSwitch']);
		const condition = choice(effect.ConditionId, ['aquaring', 'ingrain'], `${path}.ConditionId`);
		nativeFraction(effect.Fraction, `${path}.Fraction`, 1, 16);
		const order = condition === 'aquaring' ? 6 : 7;
		integer(effect.ResidualOrder, `${path}.ResidualOrder`, order, order);
		if (effect.PreventVoluntarySwitch !== undefined || condition === 'ingrain') {
			nativeBoolean(effect.PreventVoluntarySwitch, `${path}.PreventVoluntarySwitch`, condition === 'ingrain');
		}
		if (effect.PreventForcedSwitch !== undefined || condition === 'ingrain') {
			nativeBoolean(effect.PreventForcedSwitch, `${path}.PreventForcedSwitch`, condition === 'ingrain');
		}
		return { volatileStatus: condition };
	}
	case 'BindTarget': {
		object(effect, path, ['Type', 'ConditionId', 'DurationTurns', 'EndsWhenUserLeavesField', 'ResidualOrder',
			'Damage', 'DurationOverride', 'DamageOverride']);
		choice(effect.ConditionId, ['partiallytrapped'], `${path}.ConditionId`);
		const duration = object(effect.DurationTurns, `${path}.DurationTurns`, ['Min', 'Max']);
		integer(duration.Min, `${path}.DurationTurns.Min`, 5, 5);
		integer(duration.Max, `${path}.DurationTurns.Max`, 6, 6);
		nativeBoolean(effect.EndsWhenUserLeavesField, `${path}.EndsWhenUserLeavesField`, true);
		integer(effect.ResidualOrder, `${path}.ResidualOrder`, 13, 13);
		const damage = object(effect.Damage, `${path}.Damage`, ['HPBasis', 'Fraction']);
		choice(damage.HPBasis, ['BaseMaxHP'], `${path}.Damage.HPBasis`);
		nativeFraction(damage.Fraction, `${path}.Damage.Fraction`, 1, 8);
		const grip = object(effect.DurationOverride, `${path}.DurationOverride`, ['ItemId', 'DurationTurns']);
		choice(grip.ItemId, ['gripclaw'], `${path}.DurationOverride.ItemId`);
		integer(grip.DurationTurns, `${path}.DurationOverride.DurationTurns`, 8, 8);
		const band = object(effect.DamageOverride, `${path}.DamageOverride`, ['ItemId', 'Fraction']);
		choice(band.ItemId, ['bindingband'], `${path}.DamageOverride.ItemId`);
		nativeFraction(band.Fraction, `${path}.DamageOverride.Fraction`, 1, 6);
		return { volatileStatus: 'partiallytrapped' };
	}
	case 'SetSlotCondition':
		object(effect, path, ['Type', 'Condition']);
		return { slotCondition: choice(effect.Condition, ['wish'], `${path}.Condition`) };
	case 'HealOnSlotEntry': {
		object(effect, path, ['Type', 'ConditionId', 'FullyHeal', 'CureStatus', 'RestorePP', 'PreserveUntilNeeded', 'TriggerOnSwap']);
		const id = choice(effect.ConditionId, ['healingwish', 'lunardance'], `${path}.ConditionId`);
		for (const property of ['FullyHeal', 'CureStatus', 'PreserveUntilNeeded', 'TriggerOnSwap']) {
			nativeBoolean(effect[property], `${path}.${property}`, true);
		}
		if (id === 'lunardance' || 'RestorePP' in effect) nativeBoolean(effect.RestorePP, `${path}.RestorePP`, id === 'lunardance');
		return { slotCondition: id };
	}
	case 'SetSideCondition':
		object(effect, path, ['Type', 'Condition']);
		return { sideCondition: string(effect.Condition, `${path}.Condition`) };
	case 'ApplyEntryHazard':
		return { sideCondition: entryHazard(effect, path) };
	case 'ApplyDamageScreen':
		return { sideCondition: damageScreen(effect, path) };
	case 'SetFieldCondition':
		object(effect, path, ['Type', 'Condition']);
		return { pseudoWeather: string(effect.Condition, `${path}.Condition`) };
	case 'SetFieldRule':
		return { pseudoWeather: fieldRule(effect, path) };
	case 'CureTeamStatus': {
		object(effect, path, ['Type', 'IncludePartnerSide', 'BlockedByAbilities', 'BlockedBySubstitute',
			'RespectInfiltration', 'AlwaysIncludeUser', 'IgnoreBlockersWhenAbilitySuppressed']);
		const partner = bool(effect.IncludePartnerSide, `${path}.IncludePartnerSide`);
		const abilities = strings(effect.BlockedByAbilities, `${path}.BlockedByAbilities`);
		const substitute = effect.BlockedBySubstitute === undefined ? false : bool(effect.BlockedBySubstitute, `${path}.BlockedBySubstitute`);
		const infiltration = effect.RespectInfiltration === undefined ? false : bool(effect.RespectInfiltration, `${path}.RespectInfiltration`);
		const includeUser = bool(effect.AlwaysIncludeUser, `${path}.AlwaysIncludeUser`);
		const suppression = bool(effect.IgnoreBlockersWhenAbilitySuppressed, `${path}.IgnoreBlockersWhenAbilitySuppressed`);
		return { onHit(target, user, move) {
			this.add('-activate', user, `move: ${move.name}`);
			const allies = [...target.side.pokemon, ...(partner ? target.side.allySide?.pokemon ?? [] : [])];
			let cured = false;
			for (const ally of allies) {
				if (!(includeUser && ally === user) && !(suppression && this.suppressingAbility(ally))) {
					const blocker = abilities.find(ability => ally.hasAbility(ability));
					if (blocker) {
						this.add('-immune', ally, `[from] ability: ${this.dex.abilities.get(blocker).name}`);
						continue;
					}
					if (substitute && ally.volatiles['substitute'] && !(infiltration && move.infiltrates)) continue;
				}
				if (ally.cureStatus()) cured = true;
			}
			return cured;
		} };
	}
	case 'SetWeather':
		object(effect, path, ['Type', 'Weather']);
		return { weather: string(effect.Weather, `${path}.Weather`) };
	case 'SetTerrain':
		object(effect, path, ['Type', 'Terrain']);
		return { terrain: string(effect.Terrain, `${path}.Terrain`) };
	case 'Heal':
		object(effect, path, ['Type', 'Fraction', 'HPBasis', 'Rounding']);
		if ('HPBasis' in effect || 'Rounding' in effect) {
			const amount = healingAmount(effect, path);
			return { onHit(target) { return this.heal(amount(this, target), target) ? true : this.NOT_FAIL; } };
		}
		return { heal: fraction(effect.Fraction, `${path}.Fraction`) };
	case 'HealByTerrain':
	case 'HealByAbility': {
		const terrain = effect.Type === 'HealByTerrain';
		const overrideField = terrain ? 'TerrainOverride' : 'AbilityOverride';
		const selector = terrain ? 'Terrain' : 'AbilityId';
		object(effect, path, ['Type', 'HPBasis', 'Fraction', 'Rounding', overrideField, 'MarkExternalOnFoes']);
		const amount = healingAmount(effect, path);
		const location = `${path}.${overrideField}`;
		const override = object(effect[overrideField], location, [selector, 'Fraction', 'Rounding']);
		const id = string(override[selector], `${location}.${selector}`);
		const newAmount = healingAmount(override, location, effect.HPBasis);
		const mark = effect.MarkExternalOnFoes === undefined ? false : bool(effect.MarkExternalOnFoes, `${path}.MarkExternalOnFoes`);
		return { onHit(target, user) {
			const applies = terrain ? this.field.isTerrain(id) : user.hasAbility(id);
			const success = !!this.heal((applies ? newAmount : amount)(this, target), target);
			if (success && mark && !target.isAlly(user)) target.staleness = 'external';
			if (success) return true;
			this.add('-fail', target, 'heal');
			return this.NOT_FAIL;
		} };
	}
	case 'HealByVolatileLayers': {
		object(effect, path, ['Type', 'ConditionId', 'HPBasis', 'Rounding', 'HealingByLayer', 'FallbackLayers', 'RemoveVolatileAfterUse']);
		const id = string(effect.ConditionId, `${path}.ConditionId`);
		const layers = list(effect.HealingByLayer, `${path}.HealingByLayer`).map((layer, index) =>
			healingAmount({ ...effect, Fraction: layer }, `${path}.HealingByLayer[${index}]`));
		const fallback = integer(effect.FallbackLayers, `${path}.FallbackLayers`, 1, layers.length);
		const remove = bool(effect.RemoveVolatileAfterUse, `${path}.RemoveVolatileAfterUse`);
		return { onHit(target) {
			const layer = target.volatiles[id]?.layers || fallback;
			const amount = layers[Math.min(layer, layers.length) - 1](this, target);
			const success = !!this.heal(amount, target);
			if (!success) this.add('-fail', target, 'heal');
			if (remove) target.removeVolatile(id);
			return success || this.NOT_FAIL;
		} };
	}
	case 'HealUserByTargetStat': {
		object(effect, path, ['Type', 'Stat', 'IgnoreStatModifiers', 'ChangeTargetStat', 'FailAtTargetStatStage']);
		const stat = lookup(effect.Stat, stats, `${path}.Stat`);
		const ignore = bool(effect.IgnoreStatModifiers, `${path}.IgnoreStatModifiers`);
		const delta = integer(effect.ChangeTargetStat, `${path}.ChangeTargetStat`, -6, 6);
		const fail = integer(effect.FailAtTargetStatStage, `${path}.FailAtTargetStatStage`, -6, 6);
		return { onHit(target, user) {
			if (target.boosts[stat] === fail) return false;
			const hp = target.getStat(stat, false, ignore);
			const success = this.boost({ [stat]: delta }, target, user, null, false, true);
			return !!(this.heal(hp, user, target) || success);
		} };
	}
	case 'HealByWeather': {
		object(effect, path, ['Type', 'HPBasis', 'DefaultFraction', 'Rounding', 'Overrides', 'UseFieldWeather']);
		choice(effect.HPBasis, ['MaxHP', 'BaseMaxHP'], `${path}.HPBasis`);
		choice(effect.Rounding, ['ShowdownFixedPoint'], `${path}.Rounding`);
		const [n, d] = fraction(effect.DefaultFraction, `${path}.DefaultFraction`);
		const useField = effect.UseFieldWeather === undefined ? false : bool(effect.UseFieldWeather, `${path}.UseFieldWeather`);
		const useBase = effect.HPBasis === 'BaseMaxHP';
		const weatherFactors = new Map<string, number>();
		for (const [index, entry] of list(effect.Overrides, `${path}.Overrides`).entries()) {
			const location = `${path}.Overrides[${index}]`;
			const rule = object(entry, location, ['WeatherIds', 'Fraction']);
			const ratio = fraction(rule.Fraction, `${location}.Fraction`);
			for (const id of strings(rule.WeatherIds, `${location}.WeatherIds`)) {
				if (weatherFactors.has(id)) invalid(`${location}.WeatherIds`, `duplicate weather ${id}`);
				weatherFactors.set(id, ratio[0] / ratio[1]);
			}
		}
		return { onHit(pokemon) {
			const weather = useField ? this.field.effectiveWeather() : pokemon.effectiveWeather(undefined, true);
			const hp = useBase ? pokemon.baseMaxhp : pokemon.maxhp;
			const success = !!this.heal(this.modify(hp, weatherFactors.get(weather) ?? n / d));
			if (success) return true;
			this.add('-fail', pokemon, 'heal');
			return this.NOT_FAIL;
		} };
	}
	case 'Recharge':
		object(effect, path, ['Type', 'Turns']);
		integer(effect.Turns, `${path}.Turns`, 1, 1);
		return { volatileStatus: 'mustrecharge' };
	case 'ApplyRandomStatus': {
		object(effect, path, ['Type', 'Statuses']);
		const options = list(effect.Statuses, `${path}.Statuses`).map((status, index) =>
			lookup(status, statuses, `${path}.Statuses[${index}]`));
		if (!options.length) invalid(`${path}.Statuses`, 'expected at least one status');
		return { onHit(target, user, move) { return !!target.trySetStatus(this.sample(options), user, move); } };
	}
	case 'Sequence': {
		const actions = list(effect.Effects, `${path}.Effects`);
		const first = actions.length === 2 && object(actions[0], `${path}.Effects[0]`);
		if (first && first.Type === 'ApplyResidualDamage' && first.ConditionId === 'curse') {
			object(effect, path, ['Type', 'StopOnFailure', 'Effects']);
			nativeBoolean(effect.StopOnFailure, `${path}.StopOnFailure`, true);
			matchProfile(first, { Type: 'ApplyResidualDamage', ConditionId: 'curse', HPBasis: 'BaseMaxHP',
				Fraction: { Numerator: 1, Denominator: 4 }, ResidualOrder: 12 }, `${path}.Effects[0]`);
			const location = `${path}.Effects[1]`;
			const cost = object(actions[1], location, ['Type', 'Recipient', 'HPBasis', 'Fraction']);
			choice(cost.Type, ['PayHP'], `${location}.Type`);
			choice(cost.Recipient, ['User'], `${location}.Recipient`);
			choice(cost.HPBasis, ['MaxHP'], `${location}.HPBasis`);
			const [n, d] = fraction(cost.Fraction, `${location}.Fraction`);
			return { volatileStatus: 'curse', onHit(_target, user) { this.directDamage(user.maxhp * n / d, user, user); } };
		}
		const execute = eventEffect(effect, path);
		return { onHit(target, user, move) { return execute(this, target, user, move); } };
	}
	case 'CureMajorStatus':
	case 'TransformIntoTarget':
	case 'SwapAbilities':
	case 'PayHP':
	case 'SetAbility':
	case 'SwapHeldItems':
	case 'RestoreLastHeldItem':
	case 'AverageCurrentHP':
	case 'ChangeStatsBeforeUserSwitch':
	case 'DelayQueuedMove':
	case 'DestroyHeldItem':
	case 'EatTargetBerry':
	case 'SwapStoredStats':
	case 'InvertStatStages':
	case 'ClearBattlefield':
	case 'CopyStatStages':
	case 'CopyTargetTypes':
	case 'ReplaceCurrentMoveWithTargetLastMove':
	case 'ChangeRandomStat':
	case 'PrioritizeQueuedMove':
	case 'DeductLastMovePP':
	case 'QueueLastMove':
	case 'SwapStatStages':
	case 'AverageStoredStats':
	case 'TrapWhileUserIsActive': {
		const execute = eventEffect(effect, path);
		return { onHit(target, user, move) { return execute(this, target, user, move); } };
	}
	case 'MutualTrap': {
		const execute = eventEffect(effect, path);
		return { onHit(target, user, move) { execute(this, target, user, move); } };
	}
	case 'ResetStatStages':
		object(effect, path, ['Type']);
		return { onHit(target) { target.clearBoosts(); this.add('-clearboost', target); } };
	default:
		return nativeCondition(effect, path) ?? invalid(`${path}.Type`, `unsupported effect ${String(effect.Type)}`);
	}
}

function secondaries(value: unknown): SecondaryEffect[] {
	return list(value, 'Battle.SecondaryEffects').map((entry, index) => {
		const path = `Battle.SecondaryEffects[${index}]`;
		const fields = object(entry, path, ['Chance', 'Recipient', 'Effect', 'Requirements']);
		const chance = integer(fields.Chance, `${path}.Chance`, 0, 100);
		let effect: NativeHitEffect;
		if (fields.Requirements !== undefined) {
			const applies = requirements(fields.Requirements, `${path}.Requirements`);
			const execute = eventEffect(fields.Effect, `${path}.Effect`);
			effect = { onHit(target, user, move) {
				if (applies(this, user, target, move)) execute(this, target, user, move);
			} };
		} else {
			effect = hitEffect(fields.Effect, `${path}.Effect`);
		}
		return choice(fields.Recipient, ['User', 'Target'], `${path}.Recipient`) === 'User' ?
			{ chance, self: effect } : { chance, ...effect };
	});
}

function hitCount(value: unknown): MoveData['multihit'] {
	const path = 'Battle.Hits';
	const hits = object(value, path);
	switch (hits.Type) {
	case 'Fixed':
		object(hits, path, ['Type', 'Count']);
		return integer(hits.Count, `${path}.Count`, 1);
	case 'Range': {
		object(hits, path, ['Type', 'Min', 'Max']);
		const min = integer(hits.Min, `${path}.Min`, 1);
		return [min, integer(hits.Max, `${path}.Max`, min)];
	}
	default:
		return invalid(`${path}.Type`, `unsupported hit count ${String(hits.Type)}`);
	}
}

function setDamage(move: MoveData, value: unknown) {
	const path = 'Battle.Damage';
	const damage = object(value, path);
	switch (damage.Type) {
	case 'Fixed':
		object(damage, path, ['Type', 'HP']);
		move.damage = integer(damage.HP, `${path}.HP`, 1);
		break;
	case 'UserLevel':
		object(damage, path, ['Type']);
		move.damage = 'level';
		break;
	case 'OneHitKO':
		object(damage, path, ['Type', 'IceSpecialRules']);
		move.ohko = damage.IceSpecialRules !== undefined && bool(damage.IceSpecialRules, `${path}.IceSpecialRules`) ?
			'Ice' : true;
		break;
	case 'CurrentHP':
		move.damageCallback = currentHP(damage, path);
		break;
	case 'HPDifference': {
		object(damage, path, ['Type', 'From', 'Subtract']);
		const from = currentHP(damage.From, `${path}.From`);
		const subtract = currentHP(damage.Subtract, `${path}.Subtract`);
		move.damageCallback = (user, target) => from(user, target) - subtract(user, target);
		break;
	}
	case 'CurrentHPFraction': {
		object(damage, path, ['Type', 'Subject', 'HPSource', 'Fraction', 'Rounding', 'MinimumHP']);
		const subject = activePokemon(damage.Subject, `${path}.Subject`);
		const source = choice(damage.HPSource, ['Current', 'Undynamaxed'], `${path}.HPSource`);
		const [n, d] = fraction(damage.Fraction, `${path}.Fraction`);
		choice(damage.Rounding, ['Floor'], `${path}.Rounding`);
		const min = integer(damage.MinimumHP, `${path}.MinimumHP`);
		move.damageCallback = (user, target) => {
			const pokemon = subject(user, target);
			const hp = source === 'Current' ? pokemon.hp : pokemon.getUndynamaxedHP();
			return Math.max(min, Math.floor(hp * n / d));
		};
		break;
	}
	default:
		invalid(`${path}.Type`, `unsupported damage ${String(damage.Type)}`);
	}
}

function currentHP(value: unknown, path: string) {
	const fields = object(value, path, ['Type', 'Subject', 'HPSource', 'FaintSubjectOnCalculation']);
	choice(fields.Type, ['CurrentHP'], `${path}.Type`);
	const subject = activePokemon(fields.Subject, `${path}.Subject`);
	const source = choice(fields.HPSource, ['Current', 'Undynamaxed'], `${path}.HPSource`);
	const faint = fields.FaintSubjectOnCalculation === undefined ? false : bool(fields.FaintSubjectOnCalculation, `${path}.FaintSubjectOnCalculation`);
	return (user: Pokemon, target: Pokemon) => {
		const pokemon = subject(user, target);
		const hp = source === 'Current' ? pokemon.hp : pokemon.getUndynamaxedHP();
		if (faint) pokemon.faint();
		return hp;
	};
}

/** Translates a move asset without reading or inheriting the native definition of that move. */
export function translateNomelatMove(name: string, input: unknown): MoveData {
	if (!toID(name)) invalid('Move', 'expected a name with a valid ID');
	const asset = object(input, 'Asset', ['Type', 'Category', 'BasePower', 'Accuracy', 'AlwaysHits', 'PP', 'Priority', 'Battle']);
	const battle = object(asset.Battle, 'Battle', [
		'Target', 'Flags', 'PrimaryEffect', 'SelfEffect', 'SelfEffectChance', 'SelfBoost',
		'SecondaryEffects', 'Drain', 'Recoil', 'Hits', 'CriticalHit', 'OffensiveStat', 'DefensiveStat',
		'OffensivePokemon', 'UserSwitch', 'UserFaint', 'Damage', 'Bypass', 'Mechanics', 'SheerForceEligible', 'MaxHPRecoil',
		'AdditionalEffectivenessTypes', 'TypeEffectivenessOverrides',
		...Object.keys(booleanFields),
	]);
	const move: MoveData = {
		name,
		type: string(asset.Type, 'Asset.Type'),
		category: choice(asset.Category, ['Physical', 'Special', 'Status'], 'Asset.Category'),
		basePower: integer(asset.BasePower, 'Asset.BasePower'),
		accuracy: bool(asset.AlwaysHits, 'Asset.AlwaysHits') ? true : integer(asset.Accuracy, 'Asset.Accuracy', 0, 100),
		pp: integer(asset.PP, 'Asset.PP', 1),
		priority: integer(asset.Priority, 'Asset.Priority', -Number.MAX_SAFE_INTEGER),
		target: choice(battle.Target, targets, 'Battle.Target'),
		flags: Object.fromEntries(list(battle.Flags ?? [], 'Battle.Flags').map((flag, index) =>
			[string(flag, `Battle.Flags[${index}]`), 1])),
	};
	for (const [assetField, moveField] of Object.entries(booleanFields)) {
		if (assetField in battle) move[moveField] = bool(battle[assetField], `Battle.${assetField}`);
	}
	if ('PrimaryEffect' in battle) applyPrimaryEffect(move, battle.PrimaryEffect);
	if ('SelfEffect' in battle) move.self = hitEffect(battle.SelfEffect, 'Battle.SelfEffect');
	if ('SelfEffectChance' in battle) {
		if (!move.self) invalid('Battle.SelfEffectChance', 'expected SelfEffect');
		move.self.chance = integer(battle.SelfEffectChance, 'Battle.SelfEffectChance', 0, 100);
	}
	if ('SelfBoost' in battle) {
		const effect = object(battle.SelfBoost, 'Battle.SelfBoost', ['Type', 'Stages']);
		choice(effect.Type, ['ChangeStats'], 'Battle.SelfBoost.Type');
		move.selfBoost = { boosts: stageChanges(effect.Stages, 'Battle.SelfBoost.Stages') };
	}
	if ('SecondaryEffects' in battle) move.secondaries = secondaries(battle.SecondaryEffects);
	if ('SheerForceEligible' in battle && bool(battle.SheerForceEligible, 'Battle.SheerForceEligible')) move.secondaries ??= [{}];
	if ('Drain' in battle) move.drain = fraction(battle.Drain, 'Battle.Drain');
	if ('Recoil' in battle) move.recoil = fraction(battle.Recoil, 'Battle.Recoil');
	if ('MaxHPRecoil' in battle) {
		const path = 'Battle.MaxHPRecoil';
		const recoil = object(battle.MaxHPRecoil, path, ['HPBasis', 'Fraction', 'Rounding', 'Timing', 'ApplyOnMoveFailure']);
		choice(recoil.HPBasis, ['MaxHP'], `${path}.HPBasis`);
		nativeFraction(recoil.Fraction, `${path}.Fraction`, 1, 2);
		choice(recoil.Rounding, ['Nearest'], `${path}.Rounding`);
		choice(recoil.Timing, ['RecoilDamage'], `${path}.Timing`);
		nativeBoolean(recoil.ApplyOnMoveFailure, `${path}.ApplyOnMoveFailure`, false);
		move.chloroblastRecoil = true;
	}
	if ('Hits' in battle) move.multihit = hitCount(battle.Hits);
	if ('CriticalHit' in battle) {
		const crit = object(battle.CriticalHit, 'Battle.CriticalHit', ['Ratio', 'Always']);
		if ('Ratio' in crit) move.critRatio = integer(crit.Ratio, 'Battle.CriticalHit.Ratio', 1);
		if ('Always' in crit) move.willCrit = bool(crit.Always, 'Battle.CriticalHit.Always');
	}
	if ('OffensiveStat' in battle) move.overrideOffensiveStat = lookup(battle.OffensiveStat, stats, 'Battle.OffensiveStat');
	if ('DefensiveStat' in battle) move.overrideDefensiveStat = lookup(battle.DefensiveStat, stats, 'Battle.DefensiveStat');
	if ('OffensivePokemon' in battle) {
		move.overrideOffensivePokemon = choice(battle.OffensivePokemon, ['User', 'Target'], 'Battle.OffensivePokemon') ===
			'User' ? 'source' : 'target';
	}
	if ('UserSwitch' in battle) move.selfSwitch = lookup(battle.UserSwitch, switches, 'Battle.UserSwitch');
	if ('UserFaint' in battle) {
		move.selfdestruct = choice(battle.UserFaint, ['Always', 'IfHit'], 'Battle.UserFaint') === 'Always' ? 'always' : 'ifHit';
	}
	if ('Damage' in battle) setDamage(move, battle.Damage);
	if ('AdditionalEffectivenessTypes' in battle || 'TypeEffectivenessOverrides' in battle) {
		const additional = strings(battle.AdditionalEffectivenessTypes ?? [], 'Battle.AdditionalEffectivenessTypes');
		const overrides = new Map<string, number>();
		for (const [index, value] of list(battle.TypeEffectivenessOverrides ?? [], 'Battle.TypeEffectivenessOverrides').entries()) {
			const location = `Battle.TypeEffectivenessOverrides[${index}]`;
			const item = object(value, location, ['PokemonType', 'Stages']);
			const type = string(item.PokemonType, `${location}.PokemonType`);
			if (overrides.has(type)) invalid(location, `duplicate override for ${type}`);
			overrides.set(type, integer(item.Stages, `${location}.Stages`, -6, 6));
		}
		move.onEffectiveness = function (effectiveness, _target, defendingType) {
			const base = overrides.get(defendingType) ?? effectiveness;
			return additional.reduce((total, type) => total + this.dex.getEffectiveness(type, defendingType), base);
		};
	}
	if ('Bypass' in battle) {
		const bypass = object(battle.Bypass, 'Battle.Bypass', ['DefensiveBoosts', 'Evasion', 'TypeImmunity']);
		if ('DefensiveBoosts' in bypass) move.ignoreDefensive = bool(bypass.DefensiveBoosts, 'Battle.Bypass.DefensiveBoosts');
		if ('Evasion' in bypass) move.ignoreEvasion = bool(bypass.Evasion, 'Battle.Bypass.Evasion');
		if ('TypeImmunity' in bypass) move.ignoreImmunity = bool(bypass.TypeImmunity, 'Battle.Bypass.TypeImmunity');
	}
	if ('Mechanics' in battle) {
		for (const [index, value] of list(battle.Mechanics, 'Battle.Mechanics').entries()) {
			useMechanic(move, value, `Battle.Mechanics[${index}]`);
		}
	}
	return move;
}

/** Publishes translated assets for future battles using the engine's existing Dex registry. */
export class NomelatMoveCatalog {
	readonly #makeRegistry: () => EngineDex;
	#assets = new Map<string, MoveData>();
	#registry: EngineDex;

	constructor(makeRegistry: () => EngineDex) {
		this.#makeRegistry = makeRegistry;
		this.#registry = makeRegistry();
	}

	update(input: Record<string, unknown>): void {
		this.#publish(new Map(this.#assets), input);
	}

	replace(input: Record<string, unknown>): void {
		this.#publish(new Map(), input);
	}

	/** Use at battle start. The returned registry and move IDs belong to the same catalog. */
	snapshot() {
		const registry = this.#registry;
		const assets = this.#assets;
		return {
			registry,
			moveId(assetId: string): string {
				const move = assets.get(toID(assetId));
				if (!move) throw new Error(`Nomelat move is not published: ${assetId}`);
				return toID(move.name);
			},
		};
	}

	#publish(next: Map<string, MoveData>, input: Record<string, unknown>) {
		const batch = new Set<string>();
		for (const [assetId, asset] of Object.entries(object(input, 'Moves'))) {
			const id = toID(assetId);
			if (!id || batch.has(id)) throw new Error(`Invalid or duplicate Nomelat move ID: ${assetId}`);
			batch.add(id);
			try {
				next.set(id, translateNomelatMove(`Nomelat ${assetId}`, asset));
			} catch (error) {
				throw new Error(`${assetId}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
			}
		}
		// Rebuilding from the base also removes properties deleted from a previously published asset.
		const registry = this.#makeRegistry();
		if (registry === this.#registry) throw new Error('Expected a new EngineDex for publishing Nomelat moves');
		const moves: Record<string, MoveData> = {};
		for (const move of next.values()) {
			const id = toID(move.name);
			if (registry.dex.moves.get(id).exists) throw new Error(`Nomelat move ID conflicts with the engine: ${id}`);
			moves[id] = move;
		}
		registry.register({ moves });
		this.#assets = next;
		this.#registry = registry;
	}
}

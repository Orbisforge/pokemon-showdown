'use strict';

const assert = require('../../assert');
const { Dex } = require('../../../dist/sim');
const { EngineBattleStream } = require('../../../dist/sim/engine-battle-stream');
const { EngineDex } = require('../../../dist/sim/engine-dex');

const start = '>start {"format":{"mod":"gen9","gameType":"singles","ruleset":[]}}';
const alice = { name: 'Alice', team: [{ species: 'Pikachu', level: 100, moves: ['tackle'] }] };
const bob = { name: 'Bob', team: [{ species: 'Eevee', level: 1, moves: ['tackle'] }] };

describe('EngineBattleStream', () => {
	it('uses the supplied format and teams and reports the winner', async () => {
		const stream = new EngineBattleStream({ noCatch: true });
		await stream.write([
			start, `>player p1 ${JSON.stringify(alice)}`, `>player p2 ${JSON.stringify(bob)}`,
			'>p1 move 1', '>p2 move 1',
		].join('\n'));

		assert.equal(stream.battle.format.name, 'Orbisforge singles');
		assert.equal(stream.battle.teamGenerator, null);
		assert.equal(stream.battle.winner, 'Alice');
		const messages = [];
		for await (const message of stream) messages.push(message);
		assert(messages.some(message => message.startsWith('sideupdate\np1\n|request|')));
		assert(messages.some(message => message.startsWith('sideupdate\np2\n|request|')));
		assert(messages.some(message => message.includes('\n|win|Alice')));

		const replay = new EngineBattleStream({ noCatch: true });
		await replay.write(stream.battle.inputLog.join('\n'));
		assert.equal(replay.battle.winner, 'Alice');
	});

	it('requires explicit teams for both inline and separate players', async () => {
		const inline = new EngineBattleStream({ noCatch: true });
		const options = JSON.parse(start.slice('>start '.length));
		await assert.rejects(async () => inline.write(`>start ${JSON.stringify({ ...options, p1: alice, p2: {} })}`),
			/Player p2 requires an explicit team/);

		const stream = new EngineBattleStream({ noCatch: true });
		await stream.write(start);
		await assert.rejects(async () => stream.write('>player p1 {"name":"Alice"}'),
			/Player p1 requires an explicit team/);
		await assert.rejects(async () => stream.write('>player p1 {"name":"Alice","team":[]}'),
			/Expected a nonempty explicit team/);
		await stream.writeEnd();
	});

	it('uses registered data and returns the updated state by Pokemon ID', async () => {
		const engineDex = new EngineDex();
		const originalTackle = Dex.moves.get('tackle').basePower;
		const effects = new Set();
		engineDex.register({
			species: { orbeon: {
				name: 'Orbeon', num: 10001, types: ['Normal'], abilities: { 0: 'Orbis Force' },
				baseStats: { hp: 100, atk: 100, def: 100, spa: 100, spd: 100, spe: 100 },
				eggGroups: ['Field'], weightkg: 10,
			} },
			moves: {
				orbishit: {
					name: 'Orbis Hit', basePower: 240, accuracy: true, pp: 10,
					category: 'Physical', type: 'Normal', priority: 0, target: 'normal', flags: {},
				},
				tackle: { basePower: 55 },
			},
			natures: { orbisnature: { name: 'Orbis Nature', plus: 'atk', minus: 'spa' } },
			abilities: { orbisforce: {
				name: 'Orbis Force',
				onModifyAtk() { effects.add('ability'); },
			} },
			items: { orbisstone: {
				name: 'Orbis Stone',
				onModifyAtk() { effects.add('item'); },
			} },
		});
		assert(engineDex.dex.species.get('orbeon').exists);
		assert(engineDex.dex.moves.all().some(move => move.id === 'orbishit'));
		assert.equal(engineDex.dex.natures.get('orbisnature').plus, 'atk');
		assert(engineDex.dex.abilities.get('orbisforce').exists);
		assert(engineDex.dex.items.get('orbisstone').exists);
		assert(!Dex.species.get('orbeon').exists);
		assert(!Dex.moves.get('orbishit').exists);
		assert(!Dex.natures.get('orbisnature').exists);
		assert(!Dex.abilities.get('orbisforce').exists);
		assert(!Dex.items.get('orbisstone').exists);
		assert.equal(Dex.moves.get('tackle').basePower, originalTackle);
		assert.equal(new EngineDex().dex.moves.get('tackle').basePower, originalTackle);

		const stream = new EngineBattleStream({ engineDex, noCatch: true });
		await stream.write(start.replace('gen9', 'orbisforge'));
		engineDex.register({ moves: { tackle: { basePower: 60 } } });
		assert.equal(stream.battle.dex.moves.get('tackle').basePower, 55);
		assert.equal(engineDex.dex.moves.get('tackle').basePower, 60);

		const host = {
			name: 'Alice',
			team: [{
				species: 'Orbeon', level: 100, moves: ['Splash', 'Orbis Hit'],
				nature: 'Orbis Nature', ability: 'Orbis Force', item: 'Orbis Stone',
			}],
			pokemonState: [{ id: 'party-123', hp: 120, status: 'psn', pp: [3, 5] }],
		};
		const wild = {
			name: 'Wild', team: [{ species: 'Eevee', level: 1, moves: ['Splash'] }],
			pokemonState: [{ id: 'wild-456' }],
		};
		await stream.write(`>player p1 ${JSON.stringify(host)}\n>player p2 ${JSON.stringify(wild)}`);
		const pokemon = stream.battle.p1.active[0];
		assert.equal(pokemon.hp, 120);
		assert.equal(pokemon.status, 'psn');
		assert.deepEqual(pokemon.moveSlots.map(move => move.pp), [3, 5]);
		const neutralAttack = stream.battle.statModify(pokemon.species.baseStats, { ...pokemon.set, nature: 'Hardy' }, 'atk');
		assert(pokemon.baseStoredStats.atk > neutralAttack);

		await stream.write('>p1 move 1\n>p2 move 1\n>p1 move 2\n>p2 move 1');
		const messages = [];
		for await (const message of stream) messages.push(message);
		const result = JSON.parse(messages.find(message => message.startsWith('end\n')).slice(4));
		assert.equal(result.winner, 'Alice');
		assert.deepEqual([...effects].sort(), ['ability', 'item']);
		assert.deepEqual(result.pokemonState.p1, [{
			id: 'party-123', hp: 120 - Math.floor(pokemon.maxhp / 8), maxHp: pokemon.maxhp, status: 'psn', pp: [2, 4],
		}]);
		assert.equal(result.pokemonState.p2[0].id, 'wild-456');
		assert.equal(result.pokemonState.p2[0].hp, 0);
	});

	it('rejects invalid state and restores the sleep counter on a retry', async () => {
		const stream = new EngineBattleStream({ noCatch: true });
		await stream.write(start);
		const setState = state => `>player p1 ${JSON.stringify({ ...alice, pokemonState: [state] })}`;
		await assert.rejects(async () => stream.write(setState({ id: 'alice-1', hp: 9999 })), /Invalid HP/);
		await assert.rejects(async () => stream.write(setState({ id: 'alice-1', pp: [9999] })), /Invalid PP/);
		await assert.rejects(async () => stream.write(setState({ id: 'alice-1', status: 'slp' })), /sleepTurns/);
		await stream.write(setState({ id: 'alice-1', hp: 100, status: 'slp', sleepTurns: 3, pp: [4] }));
		await assert.rejects(async () => stream.write(
			`>player p2 ${JSON.stringify({ ...bob, pokemonState: [{ id: 'alice-1' }] })}`
		), /unique Pokemon ID/);
		await stream.write(`>player p2 ${JSON.stringify(bob)}\n>p1 move 1\n>p2 move 1\n>forcetie`);
		const messages = [];
		for await (const message of stream) messages.push(message);
		const result = JSON.parse(messages.find(message => message.startsWith('end\n')).slice(4));
		assert.equal(result.pokemonState.p1[0].sleepTurns, 2);
		assert.deepEqual(result.pokemonState.p1[0].pp, [4]);
		assert.equal(result.pokemonState.p2[0].id, 'p2:1');
	});

	it('keeps the previous Dex when a registration batch fails', () => {
		const engineDex = new EngineDex();
		const previous = engineDex.dex;
		assert.throws(() => engineDex.register({
			moves: { tackle: { basePower: 55 } },
			natures: { bogus: { name: 'Mismatched Name' } },
		}), /matching name/);
		assert.equal(engineDex.dex, previous);
		assert.equal(engineDex.dex.moves.get('tackle').basePower, Dex.moves.get('tackle').basePower);
	});
});

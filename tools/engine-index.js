(function openShowdown(host) {
	'use strict';

	globalThis.global = globalThis;
	const cache = new Map();
	const dirname = file => file.slice(0, file.lastIndexOf('/')) || '/';
	function resolve(...parts) {
		const result = [];
		for (const part of parts) {
			if (part.startsWith('/')) result.length = 0;
			for (const segment of part.split('/')) {
				if (!segment || segment === '.') continue;
				if (segment === '..') result.pop();
				else result.push(segment);
			}
		}
		return '/' + result.join('/');
	}

	// Showdown compares plain species data and arrays through node:util.
	function isDeepStrictEqual(left, right) {
		if (Object.is(left, right)) return true;
		if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
		if (Object.getPrototypeOf(left) !== Object.getPrototypeOf(right)) return false;
		const keys = Object.keys(left);
		return keys.length === Object.keys(right).length &&
			keys.every(key => Object.hasOwn(right, key) && isDeepStrictEqual(left[key], right[key]));
	}

	const modules = {
		util: { isDeepStrictEqual },
		path: { sep: '/', resolve, dirname, join: (...parts) => resolve(parts.join('/')) },
		fs: {
			readFileSync: file => host.readFile(file),
			readdirSync: directory => JSON.parse(host.list(directory)),
			existsSync: file => host.isFile(file),
		},
		crypto: {
			getRandomValues(array) {
				const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
				const random = host.randomBytes(bytes.length);
				for (let i = 0; i < bytes.length; i++) {
					bytes[i] = parseInt(random.slice(i * 2, i * 2 + 2), 16);
				}
				return array;
			},
		},
	};

	// Load the engine's CommonJS files inside the extracted package only.
	function load(request, parent = '/') {
		const builtin = request.startsWith('node:') ? request.slice(5) : request;
		if (Object.hasOwn(modules, builtin)) return modules[builtin];
		const local = request.startsWith('.') || request.startsWith('/');
		const base = local ? resolve(parent, request) : resolve('/node_modules', builtin);
		let file = [base, base + '.js', base + '.json'].find(candidate => host.isFile(candidate));
		if (!file && host.isFile(base + '/package.json')) {
			const entry = JSON.parse(host.readFile(base + '/package.json')).main ?? 'index.js';
			return load(resolve(base, entry), parent);
		}
		if (!file && host.isFile(base + '/index.js')) file = base + '/index.js';
		if (!file) {
			const error = new Error('Cannot find module ' + request + ' from ' + parent);
			error.code = 'MODULE_NOT_FOUND';
			throw error;
		}
		if (cache.has(file)) return cache.get(file).exports;
		const module = { exports: {} };
		cache.set(file, module);
		try {
			const source = host.readFile(file);
			if (file.endsWith('.json')) {
				module.exports = JSON.parse(source);
			} else {
				const dir = dirname(file);
				const run = new Function('require', 'module', 'exports', '__filename', '__dirname', source);
				run(specifier => load(specifier, dir), module, module.exports, file, dir);
			}
			return module.exports;
		} catch (error) {
			cache.delete(file);
			throw error;
		}
	}

	const { EngineBattleStream } = load('/sim/engine-battle-stream.js');
	const { EngineDex } = load('/sim/engine-dex.js');
	const { NomelatBattleCatalog } = load('/nomelat/abilities.js');
	const catalog = new NomelatBattleCatalog(() => new EngineDex());
	const battles = new Map();
	let assetIds = JSON.stringify({ moves: {}, abilities: {} });

	function replaceAssets(json) {
		const assets = JSON.parse(json);
		if (!assets || Array.isArray(assets) || typeof assets !== 'object' ||
			Object.keys(assets).some(key => key !== 'moves' && key !== 'abilities')) {
			throw new Error('Expected an object containing Nomelat moves and abilities');
		}
		catalog.replace(assets);
		const { moveId, abilityId } = catalog.snapshot();
		assetIds = JSON.stringify({
			moves: Object.fromEntries(Object.keys(assets.moves ?? {}).map(id => [id, moveId(id)])),
			abilities: Object.fromEntries(Object.keys(assets.abilities ?? {}).map(id => [id, abilityId(id)])),
		});
		return assetIds;
	}

	function sendBattleMessage(id, commands) {
		const stream = battles.get(id);
		if (!stream) throw new Error('Unknown battle: ' + id);
		stream.write(commands);
		return stream.buf.splice(0);
	}

	function endBattle(id) {
		const stream = battles.get(id);
		if (!stream) return false;
		battles.delete(id);
		stream.destroy();
		return true;
	}

	function startBattle(id, commands) {
		if (battles.has(id)) throw new Error('Battle already exists: ' + id);
		battles.set(id, new EngineBattleStream({
			engineDex: catalog.snapshot().registry,
			noCatch: true,
			keepAlive: true,
		}));
		try {
			return sendBattleMessage(id, commands);
		} catch (error) {
			endBattle(id);
			throw error;
		}
	}

	return { startBattle, sendBattleMessage, endBattle, replaceAssets, getAssetIds: () => assetIds };
})

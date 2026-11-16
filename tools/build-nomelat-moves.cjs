'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');

const root = path.resolve(__dirname, '..');
const distribution = path.join(root, '.engine-dist');
if (!fs.existsSync(path.join(distribution, 'sim', 'engine-dex.js'))) {
	throw new Error('Build the simulator with node build --engine before packaging Nomelat moves.');
}

buildSync({
	entryPoints: {
		moves: path.join(__dirname, 'nomelat-moves.mts'),
		abilities: path.join(__dirname, 'nomelat-abilities.mts'),
	},
	outdir: path.join(distribution, 'nomelat'),
	bundle: true,
	format: 'cjs',
	target: 'es2022',
});
console.log('Nomelat asset translators built in .engine-dist/nomelat');

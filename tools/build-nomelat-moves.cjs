'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');

const root = path.resolve(__dirname, '..');
const distribution = path.join(root, '.engine-dist');
if (!fs.existsSync(path.join(distribution, 'sim', 'engine-dex.js'))) {
	throw new Error('Build the simulator with node build --engine before packaging Nomelat moves.');
}

const outfile = path.join(distribution, 'nomelat', 'moves.js');
buildSync({
	entryPoints: [path.join(__dirname, 'nomelat-moves.mts')],
	outfile,
	bundle: true,
	format: 'cjs',
	target: 'es2022',
});
console.log('Nomelat move translator built at ' + path.relative(root, outfile));

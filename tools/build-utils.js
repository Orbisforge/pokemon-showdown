"use strict";

const fs = require("fs");
const path = require('node:path');
const child_process = require("child_process");
const esbuild = require('esbuild');

const copyOverDataJSON = (outdir = 'dist', file = 'data', include = () => true) => {
	const files = fs.readdirSync(file);
	for (const f of files) {
		const source = `${file}/${f}`;
		if (!include(source)) continue;
		if (fs.statSync(source).isDirectory()) {
			copyOverDataJSON(outdir, source, include);
		} else if (f.endsWith('.json')) {
			const destination = path.resolve(outdir, source);
			fs.mkdirSync(path.dirname(destination), { recursive: true });
			fs.copyFileSync(source, destination);
		}
	}
};

const shouldBeCompiled = file => {
	if (file.includes('node_modules/')) return false;
	if (file.endsWith('.tsx')) return true;
	if (file.endsWith('.ts')) return !(file.endsWith('.d.ts') || file.includes('global'));
	return false;
};

const findFilesForPath = path => {
	const out = [];
	const files = fs.readdirSync(path);
	for (const file of files) {
		if (file === '.engine-dist') continue;
		const cur = `${path}/${file}`;
		// HACK: Logs and databases exclusions are a hack. Logs is too big to
		// traverse, databases adds/removes files which can lead to a filesystem
		// race between readdirSync and statSync. Please, at some point someone
		// fix this function to be more robust.
		if (cur.includes('node_modules') || cur.includes("/logs") || cur.includes("/databases")) continue;
		if (fs.statSync(cur).isDirectory()) {
			out.push(...findFilesForPath(cur));
		} else if (shouldBeCompiled(cur)) {
			out.push(cur);
		}
	}
	return out;
};

exports.transpile = decl => {
	esbuild.buildSync({
		entryPoints: findFilesForPath('./'),
		outdir: './dist',
		outbase: '.',
		format: 'cjs',
		tsconfig: './tsconfig.json',
		sourcemap: true,
	});
	fs.copyFileSync('./config/config-example.js', './dist/config/config-example.js');
	copyOverDataJSON();

	// NOTE: replace is asynchronous - add additional replacements for the same path in one call instead of making multiple calls.
	if (decl) {
		exports.buildDecls();
	}
};

exports.buildDecls = () => {
	try {
		child_process.execSync(`node ./node_modules/typescript/bin/tsc -p sim`, { stdio: 'inherit' });
	} catch {}
};

exports.transpileEngine = () => {
	const root = fs.realpathSync(path.join(__dirname, '..'));
	const outdir = path.join(root, '.engine-dist');
	// Recreate the output so removed files cannot linger in the engine distribution.
	if (fs.existsSync(outdir)) {
		if (fs.realpathSync(outdir) !== outdir) throw new Error(`Unexpected engine output path: ${outdir}`);
		fs.rmSync(outdir, { recursive: true });
	}
	esbuild.buildSync({
		entryPoints: [
			...findFilesForPath('sim').filter(file => !/^sim\/(examples|tools)\//.test(file)),
			...findFilesForPath('data').filter(file => !/^data\/(random-battles|text)\//.test(file)),
			'lib/fs.ts', 'lib/streams.ts', 'lib/utils.ts',
		],
		outdir,
		outbase: '.',
		format: 'cjs',
		tsconfig: './tsconfig.json',
	});
	// The simulator and some formats import this entry point.
	fs.copyFileSync('tools/engine-lib.js', path.join(outdir, 'lib/index.js'));
	// The host supplies teams and formats, so the standalone engine has no
	// Smogon format catalog or random-team data.
	const formatsPath = path.join(outdir, 'config/formats.js');
	fs.mkdirSync(path.dirname(formatsPath), { recursive: true });
	fs.writeFileSync(formatsPath, `'use strict';\nexports.Formats = [];\n`);
	copyOverDataJSON(outdir, 'data', source => !source.startsWith('data/random-battles/') && !source.startsWith('data/text/'));
	fs.copyFileSync('LICENSE', path.join(outdir, 'LICENSE'));
	fs.copyFileSync(path.join(__dirname, 'engine.json'), path.join(outdir, 'engine.json'));
	const dependencyManifest = require.resolve('ts-chacha20/package.json');
	const dependencyRoot = path.dirname(dependencyManifest);
	const dependencyEntry = path.relative(dependencyRoot, require.resolve('ts-chacha20'));
	for (const file of ['package.json', 'LICENSE', dependencyEntry]) {
		const destination = path.join(outdir, 'node_modules/ts-chacha20', file);
		fs.mkdirSync(path.dirname(destination), { recursive: true });
		fs.copyFileSync(path.join(dependencyRoot, file), destination);
	}
	console.log('Engine built in .engine-dist/');
	return outdir;
};

exports.archiveEngine = source => {
	const outdir = path.join(path.dirname(source), '.engine-package');
	fs.mkdirSync(outdir, { recursive: true });
	const archive = path.join(outdir, 'nomelat-engine.zip');
	const temp = path.join(outdir, 'nomelat-engine.tmp.zip');
	const windows = process.platform === 'win32';
	const tool = windows ? 'tar.exe' : 'zip';
	fs.rmSync(temp, { force: true });
	try {
		const args = windows ? ['-a', '-cf', temp, '.'] : ['-q', '-r', temp, '.'];
		const result = child_process.spawnSync(tool, args, { cwd: source, stdio: 'inherit' });
		if (result.error) throw new Error(`Could not run ${tool} to package the engine`, { cause: result.error });
		if (result.status !== 0) throw new Error(`${tool} failed to package the engine`);
		fs.renameSync(temp, archive);
		fs.copyFileSync(path.join(source, 'engine.json'), path.join(outdir, 'engine.json'));
	} finally {
		fs.rmSync(temp, { force: true });
	}
	console.log('Engine ZIP and manifest written to .engine-package/');
};

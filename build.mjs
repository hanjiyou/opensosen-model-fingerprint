import { spawnSync } from 'node:child_process';
import { access, copyFile, cp, mkdir, mkdtemp, readFile, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { NtExecutable, NtExecutableResource, Resource } from 'resedit';

const root = fileURLToPath(new URL('.', import.meta.url));
const source = join(root, 'src');
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const binaryName = 'OpenSosenModelFingerprint.exe';

const bundleNode = {
  bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'],
  logLevel: 'warning', outExtension: { '.js': '.cjs' },
};

if (process.argv[2] === '--test') {
  const dir = await mkdtemp(join(tmpdir(), 'opensosen-desktop-tests-'));
  const bundle = join(dir, 'desktop.test.cjs');
  try {
    await build({ ...bundleNode, entryPoints: [join(root, 'tests', 'desktop.test.ts')], outfile: bundle });
    const test = spawnSync(process.execPath, ['--test', bundle], {
      cwd: root, stdio: 'inherit', windowsHide: true,
    });
    process.exitCode = test.status ?? 1;
  } finally {
    await unlink(bundle).catch(() => {});
    await rmdir(dir).catch(() => {});
  }
} else {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error('Build the Windows x64 portable package with x64 Node.js on Windows.');
  }
  const runtime = join(root, 'node_modules', 'electron', 'dist');
  await access(join(runtime, 'electron.exe'));
  const runtimeVersion = (await readFile(join(runtime, 'version'), 'utf8')).trim();
  if (runtimeVersion !== manifest.devDependencies.electron) throw new Error('Install the pinned Electron runtime before packaging.');

  const output = resolve(process.argv[2] ?? join(root, 'out', `OpenSosenModelFingerprint-${manifest.version}-win-x64`));
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output);
  await cp(runtime, output, {
    recursive: true, filter: (path) => basename(path) !== 'default_app.asar',
  });
  const executable = join(output, binaryName);
  await rename(join(output, 'electron.exe'), executable);
  const pe = NtExecutable.from(await readFile(executable), { ignoreCert: true });
  const resources = NtExecutableResource.from(pe);
  const version = Resource.VersionInfo.fromEntries(resources.entries)[0];
  if (!version) throw new Error('Electron has no Windows version resource.');
  version.setFileVersion(manifest.version, 1033);
  version.setProductVersion(manifest.version, 1033);
  version.setStringValues({ lang: 1033, codepage: 1200 }, {
    CompanyName: 'OpenSosen',
    ProductName: manifest.productName,
    FileDescription: manifest.productName,
    OriginalFilename: binaryName,
    InternalName: 'OpenSosenModelFingerprint',
  });
  version.outputToResourceEntries(resources.entries);
  resources.outputResource(pe);
  await writeFile(executable, new Uint8Array(pe.generate()));
  const appDir = join(output, 'resources', 'app');
  await mkdir(appDir, { recursive: true });

  await Promise.all([
    build({ ...bundleNode, entryPoints: { main: join(source, 'main.ts'), preload: join(source, 'preload.ts') }, outdir: appDir }),
    build({ entryPoints: [join(source, 'renderer.ts')], outfile: join(appDir, 'renderer.js'), bundle: true, target: 'es2022' }),
    copyFile(join(source, 'index.html'), join(appDir, 'index.html')),
    copyFile(join(source, 'style.css'), join(appDir, 'style.css')),
    copyFile(join(root, 'LICENSE'), join(output, 'LICENSE.OpenSosen.txt')),
    copyFile(join(root, 'node_modules', 'lmfpd-sdk', 'LICENSE'), join(output, 'LICENSE.lmfpd-sdk.txt')),
    copyFile(join(root, 'THIRD_PARTY_NOTICES.md'), join(output, 'THIRD_PARTY_NOTICES.md')),
    copyFile(join(root, 'README.md'), join(output, '使用说明.md')),
    writeFile(join(appDir, 'package.json'), JSON.stringify({ name: manifest.name, productName: manifest.productName, version: manifest.version, main: 'main.cjs' })),
  ]);
  console.log(executable);
}

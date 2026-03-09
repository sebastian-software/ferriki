import { spawnSync } from 'node:child_process';
import path from 'node:path';

const args = parseArgs(process.argv.slice(2));
const cmd = [
  'run',
  '-p',
  'ferriki-asset-gen',
  '--',
  'generate',
  '--upstream-dir',
  args.upstreamDir,
  '--output-dir',
  args.outputDir
];

if (args.sourceVersion) {
  cmd.push('--source-version', args.sourceVersion);
}
if (args.sourceCommit) {
  cmd.push('--source-commit', args.sourceCommit);
}

const result = spawnSync('cargo', cmd, {
  cwd: path.resolve('.'),
  stdio: 'inherit'
});

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

function parseArgs(argv) {
  let upstreamDir = path.resolve('assets/upstream/textmate-grammars-themes');
  let outputDir = path.resolve('assets/shiki');
  let sourceVersion;
  let sourceCommit;

  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!value) {
      throw new Error(`Missing value for ${flag}`);
    }
    if (flag === '--upstream-dir') {
      upstreamDir = path.resolve(value);
    } else if (flag === '--output-dir') {
      outputDir = path.resolve(value);
    } else if (flag === '--source-version') {
      sourceVersion = value;
    } else if (flag === '--source-commit') {
      sourceCommit = value;
    } else {
      throw new Error(`Unknown flag: ${flag}`);
    }
  }

  return { upstreamDir, outputDir, sourceVersion, sourceCommit };
}

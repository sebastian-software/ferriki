<?php

declare(strict_types=1);

use Phiki\Phiki;

$mode = $argv[1] ?? '';
$benchmarkProject = dirname(__DIR__) . '/benchmarks/phiki';
$autoloadPath = $benchmarkProject . '/vendor/autoload.php';

/** @return array<string, mixed> */
function decodeSetup(string $json): array
{
    $setup = json_decode($json, true, flags: JSON_THROW_ON_ERROR);
    if (!is_array($setup)) {
        throw new RuntimeException('Benchmark setup must be a JSON object.');
    }

    return $setup;
}

/** @param array<string, mixed> $setup */
function configureHighlighter(array $setup): Phiki
{
    $highlighter = new Phiki();
    $scopeNames = [];

    foreach ($setup['grammarFiles'] as $name => $path) {
        if (!is_string($name) || !is_string($path) || !is_file($path)) {
            throw new RuntimeException('A pinned TextMate grammar file is missing.');
        }

        $highlighter->grammar($name, $path);
        $grammar = json_decode((string) file_get_contents($path), true, flags: JSON_THROW_ON_ERROR);
        if (!is_array($grammar) || !is_string($grammar['scopeName'] ?? null)) {
            throw new RuntimeException('A pinned TextMate grammar has no scopeName.');
        }
        $scopeNames[$grammar['scopeName']] = $name;
    }

    // Phiki 2.2.1 exposes grammar registration by name, but its repository
    // keeps scope-to-name mappings for built-in grammars only. Shiki's asset
    // registry resolves embedded grammars by scope, so add the same mapping
    // for the pinned external assets without changing any grammar content.
    $repository = $highlighter->environment()->grammars;
    $scopeMap = new ReflectionProperty($repository, 'scopesToGrammar');
    $scopesToGrammar = $scopeMap->getValue($repository);
    foreach ($scopeNames as $scopeName => $name) {
        $scopesToGrammar[$scopeName] = $name;
    }
    $scopeMap->setValue($repository, $scopesToGrammar);

    $themePath = $setup['themePath'] ?? null;
    $themeName = $setup['theme'] ?? null;
    if (!is_string($themePath) || !is_file($themePath) || !is_string($themeName)) {
        throw new RuntimeException('The pinned TextMate theme file is missing.');
    }

    return $highlighter->theme($themeName, $themePath);
}

/** @return array<string, mixed> */
function runtimeInfo(): array
{
    return [
        'php' => PHP_VERSION,
        'sapi' => PHP_SAPI,
        'os' => PHP_OS_FAMILY,
        'architecture' => php_uname('m'),
        'mbstring' => extension_loaded('mbstring'),
        'oniguruma' => defined('MB_ONIGURUMA_VERSION') ? MB_ONIGURUMA_VERSION : null,
        'xdebug' => extension_loaded('xdebug'),
        'opcache' => [
            'extensionLoaded' => extension_loaded('Zend OPcache'),
            'enabled' => ini_get('opcache.enable'),
            'enabledForCli' => ini_get('opcache.enable_cli'),
            'jit' => ini_get('opcache.jit'),
            'jitBufferSize' => ini_get('opcache.jit_buffer_size'),
        ],
        'phiki' => Composer\InstalledVersions::getPrettyVersion('phiki/phiki'),
    ];
}

/** @return array{elapsedNs: int, bytes: int, html?: string} */
function render(Phiki $highlighter, string $code, string $language, string $theme, bool $includeHtml): array
{
    $started = hrtime(true);
    $html = $highlighter->codeToHtml($code, $language, $theme)
        ->cache(null)
        ->toString();
    $elapsedNs = hrtime(true) - $started;

    $result = [
        'elapsedNs' => $elapsedNs,
        'bytes' => strlen($html),
    ];
    if ($includeHtml) {
        $result['html'] = $html;
    }

    return $result;
}

function runCold(string $setupJson, string $autoloadPath): void
{
    $started = hrtime(true);
    require $autoloadPath;
    $setup = decodeSetup($setupJson);
    $highlighter = configureHighlighter($setup);

    foreach ($setup['documents'] as $document) {
        if (!is_array($document) || !is_string($document['lang'] ?? null) || !is_string($document['path'] ?? null)) {
            throw new RuntimeException('Cold benchmark document entry is invalid.');
        }

        $path = rtrim((string) $setup['repoRoot'], '/') . '/' . $document['path'];
        $code = file_get_contents($path);
        if (!is_string($code)) {
            throw new RuntimeException('Could not read a cold benchmark document.');
        }

        // Keep the cold boundary aligned with Node: rendering includes lazy
        // HTML materialization, while IPC and post-render hashing are excluded.
        $highlighter->codeToHtml($code, $document['lang'], (string) $setup['theme'])
            ->cache(null)
            ->toString();
    }

    $elapsedNs = hrtime(true) - $started;
    fwrite(STDOUT, json_encode([
        'elapsedMs' => $elapsedNs / 1_000_000,
        'documents' => count($setup['documents']),
    ], JSON_THROW_ON_ERROR) . "\n");
}

try {
    if (!is_file($autoloadPath)) {
        throw new RuntimeException('Composer dependencies are not installed for the Phiki benchmark.');
    }

    if ($mode === '--cold') {
        runCold($argv[2] ?? '{}', $autoloadPath);
        exit(0);
    }

    if ($mode !== '--warm') {
        throw new RuntimeException('Expected --warm or --cold.');
    }

    require $autoloadPath;
    $setup = decodeSetup($argv[2] ?? '{}');
    $highlighter = configureHighlighter($setup);
    fwrite(STDOUT, json_encode(['ready' => true, 'runtime' => runtimeInfo()], JSON_THROW_ON_ERROR) . "\n");
    fflush(STDOUT);

    while (($line = fgets(STDIN)) !== false) {
        try {
            $request = json_decode($line, true, flags: JSON_THROW_ON_ERROR);
            if (!is_array($request) || !is_string($request['op'] ?? null)) {
                throw new RuntimeException('Worker request must be a JSON object with an op.');
            }

            if ($request['op'] === 'shutdown') {
                fwrite(STDOUT, json_encode(['shutdown' => true], JSON_THROW_ON_ERROR) . "\n");
                fflush(STDOUT);
                break;
            }

            if ($request['op'] !== 'render' || !is_string($request['code'] ?? null) || !is_string($request['lang'] ?? null)) {
                throw new RuntimeException('Worker request must contain render code and lang values.');
            }

            $result = render($highlighter, $request['code'], $request['lang'], (string) $setup['theme'], (bool) ($request['includeHtml'] ?? false));
            fwrite(STDOUT, json_encode(['ok' => true] + $result, JSON_THROW_ON_ERROR) . "\n");
            fflush(STDOUT);
        } catch (Throwable $error) {
            fwrite(STDOUT, json_encode(['ok' => false, 'error' => $error->getMessage()], JSON_THROW_ON_ERROR) . "\n");
            fflush(STDOUT);
        }
    }
} catch (Throwable $error) {
    fwrite(STDERR, '[phiki-benchmark] ' . $error->getMessage() . "\n");
    exit(1);
}

#!/usr/bin/env node
/**
 * doctor.mjs — verificação pré-voo do shorts-forge.
 *
 * Zero dependências. Verifica o ambiente local e reporta em pt-PT.
 * Saída: 0 se o essencial (node >= 20, python3, ffmpeg com libx264+aac,
 * workspaces instalados) estiver OK; 1 caso contrário.
 * Avisos (modelos, pacotes Python, serviços :8001/:8002 parados, Ollama,
 * chaves em falta) nunca falham.
 *
 * Uso: node scripts/doctor.mjs  (ou: npm run doctor)
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const results = [];

const ok = (check, detail = '') => results.push({ level: 'ok', check, detail });
const warn = (check, detail = '') => results.push({ level: 'warn', check, detail });
const fail = (check, detail = '') => results.push({ level: 'fail', check, detail });
const info = (check, detail = '') => results.push({ level: 'info', check, detail });

function cmdExists(name, args = ['--version']) {
  try {
    execFileSync(name, args, { stdio: 'pipe', timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

function cmdOutput(name, args) {
  try {
    return execFileSync(name, args, { stdio: 'pipe', timeout: 15000, encoding: 'utf8' });
  } catch {
    return null;
  }
}

// --- 1. Node.js ---------------------------------------------------------
const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor >= 20) {
  ok('Node.js', `v${process.versions.node} (>= 20 OK)`);
} else {
  fail('Node.js', `v${process.versions.node} — necessário >= 20. Instala a versão LTS em https://nodejs.org`);
}

// --- 2. Python ----------------------------------------------------------
if (cmdExists('python3')) {
  const out = cmdOutput('python3', ['--version']) ?? '';
  ok('Python', out.trim() + ' (para transcription/tts, Fase 2)');
} else {
  fail('Python', 'python3 não encontrado no PATH. Necessário para faster-whisper e Kokoro.');
}

// --- 3. FFmpeg + encoders ------------------------------------------------
const ffmpegOut = cmdOutput('ffmpeg', ['-hide_banner', '-version']);
if (!ffmpegOut) {
  fail('FFmpeg', 'ffmpeg não encontrado no PATH. Instala: https://ffmpeg.org/download.html');
} else {
  const firstLine = ffmpegOut.split('\n')[0].trim();
  const encoders = cmdOutput('ffmpeg', ['-hide_banner', '-encoders']) ?? '';
  const encLines = encoders.split('\n');
  const hasEncoder = (name) =>
    encLines.some((l) => {
      const cols = l.trim().split(/\s+/);
      return cols[0] === 'V.....' || cols[0].startsWith('V') || cols[0].startsWith('A')
        ? cols[1] === name
        : false;
    });
  const x264 = hasEncoder('libx264');
  const aac = hasEncoder('aac');
  if (x264 && aac) {
    ok('FFmpeg', `${firstLine} — encoders libx264 e aac disponíveis`);
  } else {
    const missing = [!x264 && 'libx264', !aac && 'aac'].filter(Boolean).join(', ');
    fail('FFmpeg', `${firstLine} — faltam encoders: ${missing}`);
  }
}

// --- 4. .env vs .env.example ---------------------------------------------
const envExamplePath = join(rootDir, '.env.example');
const envPath = join(rootDir, '.env');
const parseKeys = (text) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => l.slice(0, l.indexOf('=')));

if (!existsSync(envExamplePath)) {
  fail('.env.example', 'ficheiro .env.example em falta na raiz.');
} else if (!existsSync(envPath)) {
  warn('.env', 'ficheiro .env não existe. Copia .env.example para .env e preenche as chaves.');
} else {
  const exampleKeys = parseKeys(readFileSync(envExamplePath, 'utf8'));
  const envKeys = new Set(parseKeys(readFileSync(envPath, 'utf8')));
  const missing = exampleKeys.filter((k) => !envKeys.has(k));
  if (missing.length === 0) {
    ok('.env', `${exampleKeys.length} chaves presentes (nomes verificados; valores nunca mostrados)`);
  } else {
    warn('.env', `${exampleKeys.length - missing.length}/${exampleKeys.length} chaves presentes. Ausentes: ${missing.join(', ')}`);
  }
}

// --- 5. Modelos locais (Fase 2) ------------------------------------------
for (const model of ['whisper', 'kokoro']) {
  const dir = join(rootDir, 'models', model);
  if (!existsSync(dir)) {
    warn(`modelos/${model}`, `diretório models/${model} em falta — sacar com \`npm run models:download\`.`);
  } else {
    let entries = [];
    try {
      entries = readdirSync(dir);
    } catch {
      /* mantém vazio */
    }
    if (entries.length === 0) {
      warn(`modelos/${model}`, `diretório existe mas está vazio — corre \`npm run models:download\`.`);
    } else {
      ok(`modelos/${model}`, `diretório presente (${entries.length} entrada(s))`);
    }
  }
}

// --- 6. Ollama ------------------------------------------------------------
const ollamaBase = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
try {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3000);
  const res = await fetch(`${ollamaBase}/api/tags`, { signal: ctrl.signal });
  clearTimeout(timer);
  if (res.ok) {
    ok('Ollama', `${ollamaBase} alcançável (backstop local do router)`);
  } else {
    warn('Ollama', `${ollamaBase} respondeu HTTP ${res.status} — verifica se o Ollama está a correr.`);
  }
} catch (e) {
  warn('Ollama', `${ollamaBase} não alcançável (${e.cause?.code ?? e.name}) — opcional; o router salta este provider.`);
}

// --- 7. Pacotes do workspace ----------------------------------------------
let pkgDir;
try {
  pkgDir = readdirSync(join(rootDir, 'packages'), { withFileTypes: true });
} catch {
  pkgDir = [];
}
const pkgs = pkgDir.filter((d) => d.isDirectory() && existsSync(join(rootDir, 'packages', d.name, 'package.json')));
if (pkgs.length === 0) {
  fail('workspaces', 'nenhum pacote encontrado em packages/*/package.json.');
} else {
  ok('workspaces', `${pkgs.length} pacotes: ${pkgs.map((p) => p.name).join(', ')}`);
}

// --- 8. WebGPU (modo browser, não verificável headless) --------------------
info('WebGPU', 'não é possível verificar sem browser — ativa-se na UI (modo WebLLM) se o browser suportar WebGPU.');

// --- 9. Pacotes Python dos serviços (Fase 2) ---------------------------------
// Verificação por import — sem instalar nada. Avisos, nunca falhas.
const pyPackages = [
  { mod: 'faster_whisper', label: 'faster-whisper (transcrição)' },
  { mod: 'kokoro', label: 'kokoro (TTS local)' },
  { mod: 'edge_tts', label: 'edge-tts (TTS fallback)' },
  { mod: 'google.cloud.texttospeech', label: 'google-cloud-texttospeech (TTS opcional)' },
];
if (!cmdExists('python3')) {
  warn('pacotes Python', 'python3 indisponível — verificação de imports saltada.');
} else {
  for (const { mod, label } of pyPackages) {
    const importable = (() => {
      try {
        execFileSync('python3', ['-c', `import ${mod}`], { stdio: 'pipe', timeout: 30000 });
        return true;
      } catch {
        return false;
      }
    })();
    if (importable) {
      ok(`Python: ${label}`, 'import OK');
    } else {
      warn(
        `Python: ${label}`,
        `módulo '${mod}' não importável. Instala-o antes de arrancar o serviço (ver README "Fase 2 — pôr a funcionar").`,
      );
    }
  }
}

// --- 10. Serviços Python :8001/:8002 (reachability — warn, não fail) ---------
async function probeHealth(port, label) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2000);
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (res.ok) {
      let detail = 'a responder';
      try {
        const body = await res.json();
        if (body && typeof body === 'object' && 'ok' in body) detail = `ok=${body.ok}`;
      } catch {
        /* corpo não-JSON — continua */
      }
      ok(label, `http://127.0.0.1:${port}/health — ${detail}`);
    } else {
      warn(label, `http://127.0.0.1:${port} respondeu HTTP ${res.status} — verifica o serviço.`);
    }
  } catch (e) {
    warn(
      label,
      `nada a ouvir em 127.0.0.1:${port} (${e.cause?.code ?? e.name}) — ` +
        'serviço ainda não arrancado (normal se for a primeira vez).',
    );
  }
}
await probeHealth(8001, 'transcrição :8001');
await probeHealth(8002, 'TTS :8002');

// --- 11. ffprobe (medição de durações) ---------------------------------------
// Nota: usa-se `-version` (um traço) — alguns builds/sandboxes devolvem
// código != 0 com `--version`.
if (cmdExists('ffprobe', ['-hide_banner', '-version'])) {
  ok('ffprobe', 'disponível (medição de durationSec nos serviços Python)');
} else {
  warn('ffprobe', 'não encontrado no PATH — vem normalmente com o ffmpeg; necessário para medir durações de áudio.');
}

// --- 12. Sanidade das env vars da Fase 2 -------------------------------------
// Verifica que o .env.example DOCUMENTA as vars que os serviços precisam
// (valores reais são opcionais — Google é first-class mas nunca obrigatória).
{
  const requiredDoc = ['WHISPER_MODEL', 'KOKORO_VOICE', 'TTS_ENGINE', 'SPEECH_RATE'];
  const optionalDoc = ['GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_TTS_API_KEY', 'GOOGLE_TTS_VOICE'];
  // Chaves documentadas incluem linhas comentadas `# CHAVE=` (documentada mas inativa por omissão).
  const parseDocKeys = (text) =>
    text
      .split('\n')
      .map((l) => l.trim().replace(/^#\s*/, ''))
      .filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => l.slice(0, l.indexOf('=')));
  const exampleKeys = existsSync(envExamplePath) ? parseDocKeys(readFileSync(envExamplePath, 'utf8')) : [];
  const missingDoc = requiredDoc.filter((k) => !exampleKeys.includes(k));
  if (missingDoc.length === 0) {
    ok('env Fase 2', `documentadas: ${requiredDoc.join(', ')}`);
  } else {
    warn('env Fase 2', `em falta no .env.example: ${missingDoc.join(', ')}`);
  }
  const missingOpt = optionalDoc.filter((k) => !exampleKeys.includes(k));
  if (missingOpt.length === 0) {
    info('env Google TTS', 'documentadas (opcionais): ' + optionalDoc.join(', '));
  } else {
    warn('env Google TTS', `em falta no .env.example: ${missingOpt.join(', ')} (opcionais, mas devem estar documentadas)`);
  }
  // Contrato congelado §8: a API serve em :3000 (mesma origem da UI).
  const portLine = exampleKeys.includes('PIPELINE_API_PORT')
    ? readFileSync(envExamplePath, 'utf8').split('\n').find((l) => l.trim().startsWith('PIPELINE_API_PORT'))
    : null;
  const portVal = portLine ? portLine.slice(portLine.indexOf('=') + 1).trim() : '';
  if (!exampleKeys.includes('PIPELINE_API_PORT') || portVal === '' || portVal === '3000') {
    ok('porta da API', 'contrato :3000 respeitado (ARCHITECTURE.md §8)');
  } else {
    warn('porta da API', `PIPELINE_API_PORT=${portVal} no .env.example — o contrato congelado exige :3000 (a UI tem o endereço fixo).`);
  }
  // SHORTS_FORGE_ROOT (Fase 3, i18n): opcional, só dev/testes — mas deve estar documentada.
  if (exampleKeys.includes('SHORTS_FORGE_ROOT')) {
    info('env SHORTS_FORGE_ROOT', 'documentada (opcional; só desenvolvimento/testes)');
  } else {
    warn('env SHORTS_FORGE_ROOT', 'em falta no .env.example (opcional, mas deve estar documentada)');
  }
}

// --- 13. Chaves de B-roll: Pexels / Pixabay (Fase 3) --------------------------
// Presente-ou-ausente SEM falhar: uma máquina limpa com zero chaves tem de
// continuar a dar exit 0. Os valores nunca são mostrados.
function dotEnvValue(name) {
  try {
    const text = readFileSync(join(rootDir, '.env'), 'utf8');
    const line = text
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.startsWith(`${name}=`) && !l.startsWith('#'));
    if (!line) return null;
    const v = line.slice(name.length + 1).trim();
    if (!v || /cola-aqui|example|changeme|xxx/i.test(v)) return null;
    return v; // nunca impresso
  } catch {
    return null;
  }
}
for (const [name, label] of [
  ['PEXELS_API_KEY', 'Pexels'],
  ['PIXABAY_API_KEY', 'Pixabay'],
]) {
  if (dotEnvValue(name)) {
    info(`B-roll: ${label}`, 'chave configurada no .env (valor oculto) — pesquisa de stock footage ativa');
  } else {
    info(
      `B-roll: ${label}`,
      'sem chave — o pipeline usa o fallback local (Ken Burns / fundo gerado). Chaves opcionais, nunca obrigatórias.',
    );
  }
}

// --- 14. Hyperframes CLI (Fase 3: renderFrames por segmento) ------------------
{
  const localBin = join(rootDir, 'node_modules', '.bin', 'hyperframes');
  if (existsSync(localBin) || cmdExists('hyperframes', ['--version'])) {
    ok('Hyperframes CLI', 'disponível (render de frames por segmento)');
  } else {
    warn(
      'Hyperframes CLI',
      'não encontrado — necessário para o renderFrames(). Corre `npm install` na raiz do repo.',
    );
  }
}

// --- Relatório --------------------------------------------------------------
const ICON = { ok: '✅', warn: '⚠️', fail: '❌', info: 'ℹ️' };
console.log('\nshorts-forge — doctor\n');
for (const r of results) {
  const line = `${ICON[r.level]} ${r.check}${r.detail ? ` — ${r.detail}` : ''}`;
  console.log(line);
}
const fails = results.filter((r) => r.level === 'fail').length;
const warns = results.filter((r) => r.level === 'warn').length;
console.log('');
if (fails === 0) {
  console.log(`Tudo essencial OK${warns > 0 ? ` (${warns} aviso(s))` : ''}. Pronto para continuar.`);
} else {
  console.log(`${fails} verificação(ões) crítica(s) falharam. Corrige antes de continuar.`);
}
process.exit(fails === 0 ? 0 : 1);

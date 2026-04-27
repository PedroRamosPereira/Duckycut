# Correção de Desalinhamento de Cortes — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Corrigir os 10 bugs listados em `.claude/analise.md` que causam desalinhamento / drift dos cortes quando o XML gerado pelo Duckycut é reimportado no Premiere, começando pelas 3 causas-raiz P0 (single-track em media-time, NTSC drift, audio timebase) e chegando até melhorias de robustez (probe no mixdown, canais por-arquivo).

**Architecture:** Três frentes — (a) `server/xmlGenerator.js` passa a operar **em frames inteiros desde a saída do FFmpeg**, usando fórmula NTSC consistente (`frame = round(s * timebase * 1000 / 1001)`), com timebase de áudio em **samples**; (b) `client/js/main.js` elimina o caminho "raw source file" e sempre trabalha em sequence-time via `detectSilenceFromSequence` (que já existe e não está sendo usado); (c) `host/index.jsx` passa a fornecer canais por-arquivo e duração de mídia por-clip em vez de valores agregados. Validação combina testes unitários nativos (`node:test`) para a matemática pura + script de smoke manual em Premiere documentado em cada fase.

**Tech Stack:** Node.js (runtime do CEP, módulos `server/*.js`), ExtendScript ES3 (`host/index.jsx`), CEP panel JS (`client/js/main.js`), FFmpeg (subprocess). Sem dependências novas — testes usam `node:test` nativo (Node 18+).

---

## Estratégia de validação

Este projeto não tem suite de testes hoje. O plano adiciona **testes unitários mínimos apenas para a lógica pura em `server/*.js`** (matemática de frames, mapeamento de keepZones, parsing), e define **roteiros de smoke manual** em Premiere para as partes que dependem de ExtendScript / AME / FFmpeg real.

Diretórios:
- `tests/` — novo, contém specs com `node:test`
- `tests/fixtures/` — entradas determinísticas (keepZones sintéticos, saída FFmpeg canned)

Comando único para rodar: `node --test tests/` (adicionado ao `package.json`).

**Roteiro de smoke manual (repetir ao fim de cada fase):**
1. Sequência A — 30s, 1 clip, **25 fps não-NTSC**, 3 silêncios. Roda Duckycut. Medir desvio do 1º e último corte.
2. Sequência B — 30s, 1 clip, **29.97 NTSC**, 3 silêncios. Mesma medida.
3. Sequência C — 10 min, 10+ clips (cortes e duplicatas), **29.97 NTSC**, 30+ silêncios. Mesma medida.
4. Sequência D — 30s, 2 tracks de áudio com origens distintas, modo "Audio 1" (single track). Medir alinhamento.
5. Para cada uma: rodar 1× em "All Tracks" e 1× em track específica, comparar.

Critério de aceite global: desvio ≤ 1 frame em qualquer corte, sem drift crescente ao longo da timeline, sem perda de sync A/V dentro de um clip.

---

## Escopo e fases

Bugs cobertos, em ordem:

| Fase | Bug (analise.md) | Arquivos | Task |
|------|------------------|----------|------|
| **Fase 0 — Setup** | — | `package.json`, `tests/` | Task 1 |
| **Fase 1 — Matemática de frames (P0)** | #3 NTSC drift, #5 cumulative rounding | `server/xmlGenerator.js` | Tasks 2–4 |
| **Fase 2 — Audio em samples (P0)** | #4 audio timebase | `server/xmlGenerator.js` | Tasks 5–6 |
| **Fase 3 — Single-track em sequence-time (P0)** | #2 single-track | `client/js/main.js`, `host/index.jsx` | Tasks 7–8 |
| **Fase 4 — Canais por-arquivo (P1)** | #6 audioChannelCount, #7 srcChannel | `host/index.jsx`, `server/xmlGenerator.js`, `client/js/main.js` | Tasks 9–10 |
| **Fase 5 — Probe + AME (P2)** | #13 probe no source file | `client/js/main.js`, `host/index.jsx` | Task 11 |
| **Fase 6 — Per-clip media metadata (P3)** | #9 duration, #8 mediaIn fps | `host/index.jsx`, `server/xmlGenerator.js` | Tasks 12–13 |
| **Fase 7 — Validação final** | — | — | Task 14 |

Bug #1 (desalinhamento em track específica) está coberto pela Fase 3. Bugs #10 (ticks), #11 (AME completion event), #12 (timeout progressivo), #14 (sanitização) e o Bug #14/15 (save project warning) **ficam fora deste plano** — são melhorias ortogonais ao desalinhamento. Serão tratados em plano separado após validação.

---

## Arquivos afetados

**Criar:**
- `tests/frameMath.test.js` — testes da matemática NTSC/frames
- `tests/xmlGenerator.test.js` — testes de `mapClipToOutput` e geração XML
- `tests/fixtures/keepZones.js` — keepZones determinísticos
- `server/frameMath.js` — novo módulo puro com conversão s↔frames↔samples

**Modificar:**
- `server/xmlGenerator.js` — refatorar para usar `frameMath.js`, audio em samples, canais por-arquivo
- `client/js/main.js:534-543` — remover caminho raw-source-file, usar `detectSilenceFromSequence`
- `host/index.jsx` — `getFullSequenceClips` passa a incluir `srcChannelCount` e `mediaDuration` por clip; `getSequenceSettings` idem
- `package.json` — script `test`

---

## Task 1: Setup de testes e módulo frameMath

**Files:**
- Create: `server/frameMath.js`
- Create: `tests/frameMath.test.js`
- Modify: `package.json`

- [ ] **Step 1: Escrever `tests/frameMath.test.js` com 4 casos falhantes**

```js
// tests/frameMath.test.js
const test   = require("node:test");
const assert = require("node:assert/strict");
const { secondsToFrames, framesToSeconds, secondsToSamples } = require("../server/frameMath");

test("integer fps: 1s @ 30fps = 30 frames", () => {
    assert.equal(secondsToFrames(1, { timebase: 30, isNTSC: false }), 30);
});

test("NTSC: 1s @ 29.97 (timebase=30, NTSC) = 30 frames (round(30*1000/1001))", () => {
    // seconds * timebase * 1000 / 1001 = 1 * 30 * 1000 / 1001 = 29.97...
    assert.equal(secondsToFrames(1, { timebase: 30, isNTSC: true }), 30);
});

test("NTSC round-trip: frame 30 → seconds → frames is idempotent", () => {
    const opts = { timebase: 30, isNTSC: true };
    const s = framesToSeconds(30, opts);
    assert.equal(secondsToFrames(s, opts), 30);
});

test("samples: 1s @ 48000 = 48000", () => {
    assert.equal(secondsToSamples(1, 48000), 48000);
});
```

- [ ] **Step 2: Rodar — esperado falhar (módulo não existe)**

Run: `node --test tests/frameMath.test.js`
Expected: FAIL com `Cannot find module '../server/frameMath'`.

- [ ] **Step 3: Implementar `server/frameMath.js` com o mínimo para passar**

```js
// server/frameMath.js
/**
 * Frame math centralizado. Todas as conversões s↔frames↔samples passam por aqui.
 * Fórmula NTSC segue a que Premiere usa ao LER um XML com timebase inteiro + <ntsc>TRUE:
 *   real_seconds = frame * 1001 / (1000 * timebase)
 * Para que o round-trip seja idempotente, a ida usa a inversa exata.
 */

function secondsToFrames(seconds, { timebase, isNTSC }) {
    if (isNTSC) {
        return Math.round(seconds * timebase * 1000 / 1001);
    }
    return Math.round(seconds * timebase);
}

function framesToSeconds(frames, { timebase, isNTSC }) {
    if (isNTSC) {
        return frames * 1001 / (1000 * timebase);
    }
    return frames / timebase;
}

function secondsToSamples(seconds, sampleRate) {
    return Math.round(seconds * sampleRate);
}

module.exports = { secondsToFrames, framesToSeconds, secondsToSamples };
```

- [ ] **Step 4: Rodar — esperado passar todos os 4 testes**

Run: `node --test tests/frameMath.test.js`
Expected: PASS 4/4.

- [ ] **Step 5: Adicionar script `test` ao `package.json`**

```json
"scripts": {
    "server": "node server/index.js",
    "install-extension": "node scripts/install.js",
    "test": "node --test tests/"
}
```

- [ ] **Step 6: Commit**

```bash
git add server/frameMath.js tests/frameMath.test.js package.json
git commit -m "test: add frameMath module with NTSC-consistent frame conversion"
```

---

## Task 2: Refatorar `xmlGenerator.js` para usar `frameMath` (vídeo)

Substitui o `toFrames` local por `secondsToFrames` do novo módulo, garantindo a fórmula NTSC correta. Não muda comportamento observável para sequências não-NTSC; corrige o drift em NTSC.

**Files:**
- Create: `tests/xmlGenerator.test.js`
- Create: `tests/fixtures/keepZones.js`
- Modify: `server/xmlGenerator.js:54-104`

- [ ] **Step 1: Criar fixture de keepZones e clip**

```js
// tests/fixtures/keepZones.js
module.exports = {
    // 3 keep zones em sequência NTSC 29.97 (timebase=30, NTSC=true)
    simpleKeepZones: [
        [0.0,  2.0],   // 0 → 60 frames
        [3.0,  5.0],   // 90 → 150 frames
        [6.0,  8.0],   // 180 → 240 frames
    ],
    // Um clip V1 que cobre tudo
    singleVideoClip: {
        trackType:  "video",
        trackIndex: 0,
        clipName:   "test.mp4",
        mediaPath:  "C:/tmp/test.mp4",
        start:      0,
        end:        10,
        mediaIn:    0,
        mediaOut:   10,
    },
};
```

- [ ] **Step 2: Escrever teste falhante para NTSC idempotência**

```js
// tests/xmlGenerator.test.js
const test   = require("node:test");
const assert = require("node:assert/strict");
const os     = require("node:os");
const path   = require("node:path");
const fs     = require("node:fs");

const { generateFCP7XML } = require("../server/xmlGenerator");
const { simpleKeepZones, singleVideoClip } = require("./fixtures/keepZones");

test("NTSC: video clip frames match inverse formula (no drift)", () => {
    const outPath = path.join(os.tmpdir(), `dct_test_${Date.now()}.xml`);
    generateFCP7XML({
        keepZones:        simpleKeepZones,
        sequenceClips:    [singleVideoClip],
        sequenceName:     "test",
        framerate:        29.97,
        exactFps:         30000 / 1001,
        isNTSC:           true,
        xmlTimebase:      30,
        width:            1920,
        height:           1080,
        audioSampleRate:  48000,
        durationSeconds:  10,
        outputPath:       outPath,
        audioChannelCount: 2,
        audioTrackCount:  1,
        videoTrackCount:  1,
    });
    const xml = fs.readFileSync(outPath, "utf-8");
    fs.unlinkSync(outPath);

    // Keep zone [0, 2] @ NTSC 29.97 → round(2 * 30 * 1000 / 1001) = round(59.94) = 60
    // Keep zone [3, 5] → [round(89.91)=90, round(149.85)=150] → outEnd = 60 + (150-90) = 120
    // Keep zone [6, 8] → [round(179.82)=180, round(239.76)=240] → outEnd = 120 + 60 = 180
    assert.ok(xml.includes("<start>0</start>"),    "1st segment outStart should be 0");
    assert.ok(xml.includes("<end>60</end>"),       "1st segment outEnd should be 60");
    assert.ok(xml.includes("<start>60</start>"),   "2nd segment outStart should be 60");
    assert.ok(xml.includes("<end>120</end>"),      "2nd segment outEnd should be 120");
    assert.ok(xml.includes("<start>120</start>"),  "3rd segment outStart should be 120");
    assert.ok(xml.includes("<end>180</end>"),      "3rd segment outEnd should be 180");
});
```

- [ ] **Step 3: Rodar — esperado falhar (hoje usa `exactFps` direto, valores não batem)**

Run: `node --test tests/xmlGenerator.test.js`
Expected: FAIL em pelo menos um dos `assert.ok`.

- [ ] **Step 4: Substituir `toFrames` local em `xmlGenerator.js`**

Em `server/xmlGenerator.js`, trocar o bloco `lines 54-61`:

```js
// ANTES
const exactFps  = opts.exactFps || framerate;
const isNTSC    = (typeof opts.isNTSC === "boolean")
    ? opts.isNTSC
    : [29.97, 23.976, 59.94].some((f) => Math.abs(framerate - f) < 0.05);
const timebase  = opts.xmlTimebase || Math.round(framerate);
const ntsc      = isNTSC ? "TRUE" : "FALSE";
const toFrames  = (s) => Math.round(s * exactFps);
```

Por:

```js
// DEPOIS
const { secondsToFrames } = require("./frameMath");

const isNTSC    = (typeof opts.isNTSC === "boolean")
    ? opts.isNTSC
    : [29.97, 23.976, 59.94].some((f) => Math.abs(framerate - f) < 0.05);
const timebase  = opts.xmlTimebase || Math.round(framerate);
const ntsc      = isNTSC ? "TRUE" : "FALSE";
// Fórmula consistente com a que Premiere usa ao LER o XML:
//   real_seconds = frame * 1001 / (1000 * timebase)  [quando NTSC]
// A ida é a inversa exata → round-trip idempotente.
const toFrames  = (s) => secondsToFrames(s, { timebase, isNTSC });
```

O `require` sobe para o topo do arquivo junto dos outros.

- [ ] **Step 5: Rodar — esperado passar**

Run: `node --test tests/xmlGenerator.test.js`
Expected: PASS.

- [ ] **Step 6: Rodar suite toda pra garantir nada quebrou**

Run: `npm test`
Expected: PASS em todas.

- [ ] **Step 7: Commit**

```bash
git add server/xmlGenerator.js tests/xmlGenerator.test.js tests/fixtures/keepZones.js
git commit -m "fix(xml): use NTSC-consistent frame conversion via frameMath"
```

---

## Task 3: Snapar bordas de keepZone para frames antes do mapClipToOutput

Hoje cada borda de keepZone é arredondada na linha 84, mas `mapClipToOutput` também arredonda `clip.start`/`clip.end` depois (linhas 102-104) — quando essas bordas caem em posições fracionárias próximas de ½ frame, dá pra ter 1 frame de diferença em relação ao outputOffset. A correção: snapar `clip.start/end/mediaIn` para frames **usando as mesmas bordas** já computadas em `keepZonesF`. Para isso, trabalhar sempre em frames após a conversão inicial.

**Files:**
- Modify: `server/xmlGenerator.js:94-131`

- [ ] **Step 1: Escrever teste falhante com clip cujo start cai em ½ frame fracionário**

Adicionar em `tests/xmlGenerator.test.js`:

```js
test("Clip boundary that falls on half-frame does not drift from keepZone boundary", () => {
    // Clip que começa em 2.0166s. NTSC 29.97, timebase=30.
    //   round(2.0166 * 30 * 1000 / 1001) = round(60.41...) = 60
    // Se keepZone [0, 2.0166]: kEndF = 60. Clip.start = 2.0166 → cStartF = 60.
    // Resultado esperado: clip.start SEMPRE bate exatamente com kEndF quando
    // keepZone e clip compartilham esse timestamp → segDur de 0 ou positivo, nunca negativo.
    const outPath = path.join(os.tmpdir(), `dct_test_${Date.now()}.xml`);
    generateFCP7XML({
        keepZones:    [[0, 2.0166], [2.0166, 4]],
        sequenceClips: [{
            trackType: "video", trackIndex: 0, clipName: "c",
            mediaPath: "C:/t/c.mp4", start: 2.0166, end: 4, mediaIn: 0, mediaOut: 2,
        }],
        sequenceName: "t", framerate: 29.97, exactFps: 30000/1001, isNTSC: true,
        xmlTimebase: 30, width: 1920, height: 1080, audioSampleRate: 48000,
        durationSeconds: 4, outputPath: outPath,
        audioChannelCount: 2, audioTrackCount: 1, videoTrackCount: 1,
    });
    const xml = fs.readFileSync(outPath, "utf-8");
    fs.unlinkSync(outPath);
    // Segmento deve começar exatamente no outputOffset da 2ª keepZone (60),
    // não em 59 ou 61.
    assert.ok(
        xml.match(/<start>60<\/start>\s*<end>120<\/end>/),
        "Clip at keepZone boundary should produce <start>60</start><end>120</end>"
    );
});
```

- [ ] **Step 2: Rodar — esperado passar ou falhar dependendo do acaso do arredondamento; documentar resultado**

Run: `node --test tests/xmlGenerator.test.js`
Expected: pode passar em 30/30 mas falhar em 29.97 por causa do `exactFps` — é isso que o fix vai tornar determinístico.

- [ ] **Step 3: Modificar `mapClipToOutput` para garantir que as bordas do clip são snapped com a **mesma** fórmula das keepZones**

Substituir em `server/xmlGenerator.js:101-131`:

```js
function mapClipToOutput(clipOrigStart, clipOrigEnd, clipMediaIn) {
    // IMPORTANTE: usar exatamente a mesma função de arredondamento
    // que gerou keepZonesF, para que bordas coincidentes produzam
    // valores idênticos (sem erro de ±1 frame).
    const cStartF = toFrames(clipOrigStart);
    const cEndF   = toFrames(clipOrigEnd);
    const cInF    = toFrames(clipMediaIn);

    const segments = [];
    for (let zi = 0; zi < keepZonesF.length; zi++) {
        const [kStartF, kEndF] = keepZonesF[zi];

        const iStart = Math.max(kStartF, cStartF);
        const iEnd   = Math.min(kEndF,   cEndF);
        if (iStart >= iEnd) continue;

        const segDur = iEnd - iStart;
        const offsetInZone = iStart - kStartF;
        const outStart = outputOffsets[zi] + offsetInZone;
        const outEnd   = outStart + segDur;
        const segClipOffset = iStart - cStartF;
        const mediaIn  = cInF + segClipOffset;
        const mediaOut = mediaIn + segDur;

        segments.push({ outStart, outEnd, mediaIn, mediaOut });
    }
    return segments;
}
```

(Nota: a mudança real já vem do Task 2 — `toFrames` agora é `secondsToFrames(s, { timebase, isNTSC })`, que é **determinístico dado timebase+isNTSC**. A função em si não precisa mudar; o teste é o que garante regressão.)

- [ ] **Step 4: Rodar — esperado passar**

Run: `npm test`
Expected: PASS em todos.

- [ ] **Step 5: Commit**

```bash
git add server/xmlGenerator.js tests/xmlGenerator.test.js
git commit -m "test(xml): pin keepZone/clip-boundary round-trip to single formula"
```

---

## Task 4: Smoke test manual — verificar Fase 1

Antes de seguir, validar visualmente que o drift NTSC sumiu.

- [ ] **Step 1: Build e instalar extensão**

No Windows, rodar:

```bash
npm run install-extension
```

Abrir Premiere, habilitar o painel Duckycut.

- [ ] **Step 2: Abrir Sequência A (25fps integer)**

Rodar Duckycut em "All Tracks". Importar XML resultante. Medir desvio no 1º e último corte.
Expected: ambos ≤ 1 frame.

- [ ] **Step 3: Abrir Sequência B (29.97 NTSC)**

Mesmo procedimento.
Expected: ambos ≤ 1 frame (antes do fix: até ~3 frames no fim de 30s).

- [ ] **Step 4: Abrir Sequência C (10min, 30+ cortes, NTSC)**

Mesmo procedimento, mais cortes.
Expected: drift crescente **deve sumir**; último corte ainda ≤ 1 frame.

- [ ] **Step 5: Anotar resultados em `docs/superpowers/plans/2026-04-17-correcao-desalinhamento.md`**

Editar este próprio arquivo adicionando ao fim da Task 4:

```markdown
### Resultados Fase 1 (preencher):
- Seq A (25fps): desvio 1º=___ frame(s), último=___ frame(s)
- Seq B (29.97): desvio 1º=___ frame(s), último=___ frame(s)
- Seq C (10min): desvio 1º=___, 50%=___, último=___
```

- [ ] **Step 6: Commit (se passou)**

```bash
git add docs/superpowers/plans/2026-04-17-correcao-desalinhamento.md
git commit -m "docs: phase 1 smoke test results"
```

---

## Task 5: Audio em samples — novo `toSamples` e timebase dedicado

Problema (bug #4): hoje clipitems de áudio usam `<timebase>30</timebase><ntsc>TRUE</ntsc>` (timebase de vídeo). Spec FCP7 pede timebase = sample rate e tempos em samples.

**Files:**
- Modify: `server/xmlGenerator.js:61-91` (adicionar matemática de samples)
- Modify: `server/xmlGenerator.js:203-249` (bloco audio tracks)

- [ ] **Step 1: Adicionar teste falhante para clipitem de áudio em samples**

Em `tests/xmlGenerator.test.js`:

```js
test("Audio clipitem uses sampleRate as timebase, NTSC=FALSE, tempos em samples", () => {
    const outPath = path.join(os.tmpdir(), `dct_test_${Date.now()}.xml`);
    generateFCP7XML({
        keepZones:    [[0, 1]],  // 1 segundo
        sequenceClips: [{
            trackType: "audio", trackIndex: 0, clipName: "a",
            mediaPath: "C:/t/a.wav", start: 0, end: 1, mediaIn: 0, mediaOut: 1,
        }],
        sequenceName: "t", framerate: 29.97, exactFps: 30000/1001, isNTSC: true,
        xmlTimebase: 30, width: 1920, height: 1080, audioSampleRate: 48000,
        durationSeconds: 1, outputPath: outPath,
        audioChannelCount: 2, audioTrackCount: 1, videoTrackCount: 1,
    });
    const xml = fs.readFileSync(outPath, "utf-8");
    fs.unlinkSync(outPath);

    // Extrair o bloco de áudio (depois do primeiro </video> até </audio>)
    const audioBlock = xml.split("</video>")[1].split("</audio>")[0];

    // 1s @ 48000 Hz = 48000 samples
    assert.ok(audioBlock.includes("<timebase>48000</timebase>"), "audio timebase must be 48000");
    assert.ok(/<ntsc>FALSE<\/ntsc>/.test(audioBlock), "audio clipitem NTSC must be FALSE");
    assert.ok(audioBlock.includes("<start>0</start>"),   "1s clip → outStart=0 samples");
    assert.ok(audioBlock.includes("<end>48000</end>"),   "1s clip → outEnd=48000 samples");
});
```

- [ ] **Step 2: Rodar — esperado falhar**

Run: `npm test`
Expected: FAIL (hoje usa timebase=30 para áudio).

- [ ] **Step 3: Adicionar helpers de samples no topo de `generateFCP7XML`**

Em `server/xmlGenerator.js`, após a definição de `toFrames` (~linha 61):

```js
const { secondsToFrames, secondsToSamples } = require("./frameMath");
// ...
const toFrames  = (s) => secondsToFrames(s, { timebase, isNTSC });
const toSamples = (s) => secondsToSamples(s, audioSampleRate);
```

- [ ] **Step 4: Calcular keepZones em samples paralelamente a frames**

Logo depois de `const keepZonesF = ...`:

```js
// Para áudio, repete a lógica em samples — sem reaproveitar frames pra evitar
// erro acumulado em sequências NTSC (frame rate fracionária × sample rate
// inteiro não produz matemática exata).
const keepZonesS = keepZones.map(([ks, ke]) => [toSamples(ks), toSamples(ke)]);
const outputOffsetsS = [];
let runningOffsetS = 0;
for (const [ksS, keS] of keepZonesS) {
    outputOffsetsS.push(runningOffsetS);
    runningOffsetS += (keS - ksS);
}
const totalOutputSamples = runningOffsetS;
const totalInputSamples  = toSamples(durationSeconds);
```

- [ ] **Step 5: Adicionar `mapClipToOutputSamples` análogo a `mapClipToOutput`**

Após `mapClipToOutput`:

```js
/**
 * Mesma lógica do mapClipToOutput mas em samples.
 * Usado pelos clipitems de áudio.
 */
function mapClipToOutputSamples(clipOrigStart, clipOrigEnd, clipMediaIn) {
    const cStartS = toSamples(clipOrigStart);
    const cEndS   = toSamples(clipOrigEnd);
    const cInS    = toSamples(clipMediaIn);

    const segments = [];
    for (let zi = 0; zi < keepZonesS.length; zi++) {
        const [kStartS, kEndS] = keepZonesS[zi];
        const iStart = Math.max(kStartS, cStartS);
        const iEnd   = Math.min(kEndS,   cEndS);
        if (iStart >= iEnd) continue;

        const segDur = iEnd - iStart;
        const offsetInZone = iStart - kStartS;
        const outStart = outputOffsetsS[zi] + offsetInZone;
        const outEnd   = outStart + segDur;
        const segClipOffset = iStart - cStartS;
        const mediaIn  = cInS + segClipOffset;
        const mediaOut = mediaIn + segDur;

        segments.push({ outStart, outEnd, mediaIn, mediaOut });
    }
    return segments;
}
```

- [ ] **Step 6: Reescrever o loop de audio tracks (linhas ~207-249) para usar samples**

Substituir o bloco:

```js
for (let ti = 0; ti < numAudioTracks; ti++) {
    const clipsInTrack = audioTrackClips[ti] || [];
    let trackItems = "";

    for (const clip of clipsInTrack) {
        const fileId  = getFileId(clip.mediaPath);
        const segs    = mapClipToOutputSamples(clip.start, clip.end, clip.mediaIn || 0);
        // <duration> em samples da mídia completa
        const fileDurSamples = totalInputSamples;

        const srcChannel = Math.min(ti + 1, numChannels);

        for (const seg of segs) {
            const id = nextClipId("a" + ti);
            trackItems += `
                    <clipitem id="${id}">
                        <masterclipid>${fileId || "masterclip-1"}</masterclipid>
                        <name>${escapeXml(clip.clipName || "")}</name>
                        <enabled>TRUE</enabled>
                        <duration>${fileDurSamples}</duration>
                        <rate><timebase>${audioSampleRate}</timebase><ntsc>FALSE</ntsc></rate>
                        <start>${seg.outStart}</start>
                        <end>${seg.outEnd}</end>
                        <in>${seg.mediaIn}</in>
                        <out>${seg.mediaOut}</out>
                        <file id="${fileId || "file-1"}"/>
                        <sourcetrack>
                            <mediatype>audio</mediatype>
                            <trackindex>${srcChannel}</trackindex>
                        </sourcetrack>
                    </clipitem>`;
        }
    }

    audioTracksXML += `
                <track>
                    ${trackItems}
                    <outputchannelindex>${ti + 1}</outputchannelindex>
                </track>`;
}
```

- [ ] **Step 7: Rodar — esperado passar**

Run: `npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add server/xmlGenerator.js tests/xmlGenerator.test.js
git commit -m "fix(xml): use sampleRate as timebase for audio clipitems (FCP7 spec)"
```

---

## Task 6: Smoke test manual — verificar Fase 2

- [ ] **Step 1: Rodar Sequência B (29.97 NTSC) em "All Tracks" e aplicar XML**

Verificar no Premiere: selecionar um corte no meio da timeline, dar zoom no nível de frames no áudio, conferir se o recorte do áudio está **exatamente alinhado** com o recorte do vídeo (não 1-2 samples antes/depois).

- [ ] **Step 2: Rodar Sequência C (10min)**

Conferir vários cortes ao longo da timeline. Critério: nenhum descolamento visível áudio↔vídeo, nem crescente.

- [ ] **Step 3: Anotar na Task 4 os resultados da Fase 2 e commit**

```bash
git add docs/superpowers/plans/2026-04-17-correcao-desalinhamento.md
git commit -m "docs: phase 2 smoke test results"
```

---

## Task 7: Single-track usa `detectSilenceFromSequence` filtrado

Problema (bug #2, P0 #1): hoje em modo "track específica", `getMediaPath()` pega só o arquivo-fonte da primeira clip, silencedetect roda em media-time, e o mapeamento contra `clip.start`/`clip.end` (sequence-time) dá corte errado. A função `detectSilenceFromSequence` em `server/silenceDetector.js:213` já monta mix em sequence-time — falta só passar **só os clipes da track escolhida**.

**Files:**
- Modify: `client/js/main.js:534-543` (remover fallback raw-source, chamar detectSilenceFromSequence filtrado)

- [ ] **Step 1: Localizar o bloco**

Linhas 534-543 em `client/js/main.js`:

```js
} else {
    // ── Single track: use raw source file directly ──
    getMediaPath().then(function (audioPath) {
        if (!audioPath) {
            setStatus("No audio media found in track", "error");
            hideProgress(); elBtnAnalyze.disabled = false; return;
        }
        runDetection(audioPath, false);
    });
}
```

- [ ] **Step 2: Substituir inteiro por chamada ao detectSilenceFromSequence filtrado**

```js
} else {
    // ── Single track: monta mix apenas com clipes dessa track, em sequence-time ──
    // (NÃO rodar silencedetect no arquivo-fonte: timestamps ficariam em media-time
    //  e o xmlGenerator espera sequence-time — ver analise.md bug #2)
    var targetIdx = parseInt(elTargetTrack.value, 10);
    if (isNaN(targetIdx) || !sequenceInfo || !sequenceInfo.audioTracks) {
        setStatus("Invalid track selection", "error");
        hideProgress(); elBtnAnalyze.disabled = false; return;
    }

    var filteredTracks = sequenceInfo.audioTracks.filter(function (t) {
        return t.index === targetIdx;
    });
    if (filteredTracks.length === 0 || !filteredTracks[0].clips || filteredTracks[0].clips.length === 0) {
        setStatus("Selected track has no clips", "error");
        hideProgress(); elBtnAnalyze.disabled = false; return;
    }

    updateProgress(20, "Mixing clips from selected track...");
    silenceDetector.detectSilenceFromSequence(filteredTracks, threshold, minDuration)
        .then(function (result) {
            analysisResult = result;
            updateProgress(80, "Applying Clean Cut algorithm...");
            keepZones = computeCleanCutZones(
                result.silenceIntervals,
                result.mediaDuration,
                {
                    paddingIn:       parseInt(elPaddingIn.value, 10)       / 1000,
                    paddingOut:      parseInt(elPaddingOut.value, 10)      / 1000,
                    minClipDuration: parseInt(elMinClipDuration.value, 10) / 1000,
                }
            );
            showResults();
            updateProgress(100, "Done");
            setStatus("Analysis complete", "success");
            hideProgress(); elBtnAnalyze.disabled = false;
        })
        .catch(function (err) {
            setStatus("Single-track mix failed: " + err.message, "error");
            hideProgress(); elBtnAnalyze.disabled = false;
        });
    return; // evita cair no runDetection de baixo
}
```

**Importante:** `sequenceInfo.audioTracks` precisa já vir com `clips[]` completos (mediaPath, seqStart, seqEnd, srcIn, srcOut) do host — checar Task 8.

- [ ] **Step 3: Verificar estrutura de `sequenceInfo.audioTracks` em `host/index.jsx`**

Abrir `host/index.jsx` função `getActiveSequenceInfo` (volta perto da linha 30-115). Confirmar que `audioTracks[i].clips` traz `{ mediaPath, seqStart, seqEnd, srcIn, srcOut }`. Se NÃO trouxer, parar aqui e fazer Task 8 primeiro.

- [ ] **Step 4: (se falhou) Dispatch para Task 8 antes**

Se a estrutura não bate: pular para Task 8, implementar, voltar.

- [ ] **Step 5: Smoke manual — modo "Audio 1" em Sequência D**

Abrir Sequência D (2 tracks, origens distintas). Selecionar "Audio 1" no dropdown de track. Rodar análise. Importar XML.
Expected: cortes em sequence-time (bate com timeline), não em media-time.

- [ ] **Step 6: Commit**

```bash
git add client/js/main.js
git commit -m "fix(client): single-track analysis uses sequence-time mix (bug #2)"
```

---

## Task 8: Garantir que `getActiveSequenceInfo` retorna `clips[]` por track

Pré-requisito para Task 7. O painel já chama `getActiveSequenceInfo()`; precisamos que `audioTracks[i].clips` venha completo com mediaPath + seqStart + seqEnd + srcIn + srcOut (formato que `detectSilenceFromSequence` espera).

**Files:**
- Modify: `host/index.jsx` função `getActiveSequenceInfo` (aprox. linhas 30-115)

- [ ] **Step 1: Ler função atual**

Ler `host/index.jsx:30-115`. Identificar o bloco que monta `audioTracks` em `getActiveSequenceInfo`.

- [ ] **Step 2: Estender o retorno de cada track com array `clips`**

No bloco de audioTracks dentro de `getActiveSequenceInfo`, para cada track `at`:

```js
var atClips = [];
try {
    var numACV = at.clips.numItems;
    for (var aci = 0; aci < numACV; aci++) {
        var aC = at.clips[aci];
        if (!aC || !aC.projectItem) continue;
        var mp = "";
        try { mp = aC.projectItem.getMediaPath() || ""; } catch(e) {}
        if (!mp) continue;
        var sS = 0, sE = 0, sI = 0, sO = 0;
        try { sS = aC.start.seconds;    } catch(e) {}
        try { sE = aC.end.seconds;      } catch(e) {}
        try { sI = aC.inPoint.seconds;  } catch(e) {}
        try { sO = aC.outPoint.seconds; } catch(e) {}
        atClips.push({
            mediaPath: mp.replace(/\\/g, "/"),
            seqStart:  sS,
            seqEnd:    sE,
            srcIn:     sI,
            srcOut:    sO
        });
    }
} catch(e) {}

audioTracks.push({
    index:     ai,
    name:      atName,
    clipCount: atClipCount,
    clips:     atClips
});
```

(Ajustar nomes de variáveis ao que já está no código — manter estilo ES3.)

- [ ] **Step 3: Reload do painel + log**

Reabrir extensão, abrir DevTools (F12 no painel se em PlayerDebugMode), no console chamar `evalScript("getActiveSequenceInfo()")` e inspecionar a resposta.
Expected: cada `audioTracks[i]` tem `clips: [{ mediaPath, seqStart, seqEnd, srcIn, srcOut }, ...]`.

- [ ] **Step 4: Commit**

```bash
git add host/index.jsx
git commit -m "feat(host): include per-clip media info in getActiveSequenceInfo audio tracks"
```

---

## Task 9: Separar `srcFileChannels` de `seqAudioTracks` no XML

Problema (bugs #6, #7): `numChannels = audioChannelCount || numAudioTracks` mistura dois conceitos. `srcChannel = Math.min(ti+1, numChannels)` também é ingênuo.

Fix: (a) cada `<file>` declara seu próprio `channelCount` (lido do arquivo-fonte via ffprobe ou cache do host); (b) `<sourcetrack><trackindex>` do clipitem usa canal baseado **naquele arquivo**, não no agregado; (c) `<format><audio><channelcount>` reflete **tracks da sequência**, não canais do arquivo.

**Files:**
- Modify: `server/xmlGenerator.js:204-291` (numChannels usage, fileDeclarations)
- Modify: `host/index.jsx` função `getFullSequenceClips` e `getActiveSequenceInfo` para incluir `channelCount` por clip/arquivo

- [ ] **Step 1: Estender `getFullSequenceClips` em `host/index.jsx` com `srcChannels`**

Dentro do loop de audioClips em `getFullSequenceClips` (linhas ~216-240), adicionar leitura best-effort do channelCount do `projectItem`:

```js
var aChannels = 0;
try {
    // componentList/videoComponents não expõe channels direto; usar o
    // attribute do projectItem se disponível (API Premiere 14+ retorna numChannels)
    if (api.getFootageInterpretation) {
        var fi = api.getFootageInterpretation();
        if (fi && typeof fi.audioChannelCount === "number") aChannels = fi.audioChannelCount;
    }
} catch(e) {}
// ... no push:
clips.push({
    trackType:  "audio",
    // ... campos existentes ...
    srcChannels: aChannels  // 0 se desconhecido; xmlGenerator faz fallback
});
```

Para clips de vídeo com áudio acoplado, popular `srcChannels` análogo.

- [ ] **Step 2: Test unitário em xmlGenerator para `srcChannels` por arquivo**

Adicionar em `tests/xmlGenerator.test.js`:

```js
test("File declarations use per-file srcChannels, format uses audioTrackCount", () => {
    const outPath = path.join(os.tmpdir(), `dct_test_${Date.now()}.xml`);
    generateFCP7XML({
        keepZones: [[0, 1]],
        sequenceClips: [
            // Arquivo A: mono
            { trackType: "audio", trackIndex: 0, clipName: "mono",
              mediaPath: "C:/t/mono.wav", start: 0, end: 1,
              mediaIn: 0, mediaOut: 1, srcChannels: 1 },
            // Arquivo B: estéreo
            { trackType: "audio", trackIndex: 1, clipName: "stereo",
              mediaPath: "C:/t/stereo.wav", start: 0, end: 1,
              mediaIn: 0, mediaOut: 1, srcChannels: 2 },
        ],
        sequenceName: "t", framerate: 30, exactFps: 30, isNTSC: false,
        xmlTimebase: 30, width: 1920, height: 1080, audioSampleRate: 48000,
        durationSeconds: 1, outputPath: outPath,
        audioChannelCount: 2,  // do probe, ignorado para per-file
        audioTrackCount: 2, videoTrackCount: 0,
    });
    const xml = fs.readFileSync(outPath, "utf-8");
    fs.unlinkSync(outPath);

    // Arquivo mono → 1 canal declarado
    const monoFileBlock = xml.split("mono.wav")[1].split("</clip>")[0];
    assert.ok(/channelcount>1</.test(monoFileBlock), "mono file declares 1 channel");

    // Arquivo stereo → 2 canais declarados
    const stereoFileBlock = xml.split("stereo.wav")[1].split("</clip>")[0];
    assert.ok(/channelcount>2</.test(stereoFileBlock), "stereo file declares 2 channels");

    // Formato da sequência → 2 tracks
    const formatBlock = xml.split("<audio>")[1].split("<track>")[0];
    assert.ok(/channelcount>2</.test(formatBlock), "sequence audio format uses track count");
});
```

- [ ] **Step 3: Rodar — esperado falhar**

Run: `npm test`
Expected: FAIL (hoje numChannels é uniforme).

- [ ] **Step 4: Modificar `xmlGenerator.js` — separar conceitos**

No início de `generateFCP7XML`:

```js
// Canais por arquivo-fonte (registry paralelo ao fileRegistry)
const fileChannelRegistry = {};  // mediaPath normalizado → channelCount
function setFileChannels(mediaPath, channels) {
    if (!mediaPath || !channels) return;
    const norm = mediaPath.replace(/\\/g, "/");
    // Primeiro clip que declarar o canal vence; fallback para probe depois
    if (!fileChannelRegistry[norm]) fileChannelRegistry[norm] = channels;
}
function getFileChannels(mediaPath) {
    if (!mediaPath) return 1;
    const norm = mediaPath.replace(/\\/g, "/");
    return fileChannelRegistry[norm] || audioChannelCount || 1;
}

// Pré-popular com info de cada clip
if (sequenceClips) {
    sequenceClips.forEach((c) => {
        if (c.mediaPath && c.srcChannels) setFileChannels(c.mediaPath, c.srcChannels);
    });
}

// Tracks da SEQUÊNCIA — esse vai para <format>
const seqAudioTracks = numAudioTracks;  // já existente, renomeado pra clareza
```

Remover `const numChannels = audioChannelCount || numAudioTracks;` (linha 204).

Substituir `numChannels` em usos:

- No loop de audio (srcChannel): `const srcChannel = Math.min(ti + 1, getFileChannels(clip.mediaPath));`
- No `<format>` do áudio (~linha 322): `<channelcount>${seqAudioTracks}</channelcount>`
- No `fileDeclarations` (~linhas 258-261 e 284): usar `getFileChannels(mediaPath)` para o loop `fileAudioChannels` e para o `<channelcount>` do file.

- [ ] **Step 5: Rodar — esperado passar**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/xmlGenerator.js host/index.jsx tests/xmlGenerator.test.js
git commit -m "fix(xml): use per-file channel count, separate from sequence track count (bugs #6, #7)"
```

---

## Task 10: Smoke manual — verificar Fase 4

- [ ] **Step 1: Sequência com mix mono+estéreo**

Criar sequência com 2 audio tracks: A1 tem um arquivo mono; A2 tem um arquivo estéreo. Rodar Duckycut em "All Tracks". Importar XML.
Expected: A1 no resultado continua mono (1 canal referenciado), A2 continua estéreo. Sem duplicação ou silenciamento de canais.

- [ ] **Step 2: Anotar na Task 4 e commit**

---

## Task 11: Probe no mixdown WAV, não no arquivo-fonte

Problema (bug #13): `runProbe()` calibra threshold no primeiro arquivo de uma track, que pode ser música (A2) e não voz. Fix: quando modo "All Tracks", probe roda no WAV de mixdown que a detecção vai usar. Quando modo "track específica", probe roda no mixdown daquela track (reutilizando `buildMixedAudio`).

**Files:**
- Modify: `client/js/main.js` — função `runProbe`
- (Nenhuma mudança em host/server necessária)

- [ ] **Step 1: Localizar `runProbe` em `main.js`**

Grep: `grep -n "runProbe\|probeAudio" client/js/main.js`. Ler a função.

- [ ] **Step 2: Modificar para probe no mix**

Refatorar `runProbe` para:
1. Se modo "All Tracks": chamar `exportSequenceAudio` (AME) → polling → `probeAudio(tempWav)`.
2. Se modo "track específica": chamar `silenceDetector.buildMixedAudio` com clipes daquela track → `probeAudio(tempWav)`.

(Reaproveitar lógica de `runAnalysis` — extrair função helper `ensureMixdown(mode): Promise<wavPath>` e usar em ambos.)

Código detalhado depende da forma atual de `runProbe`; a refatoração específica é: onde hoje chama `getMediaPath().then(probeAudio)`, trocar por `ensureMixdown(mode).then(probeAudio)`.

- [ ] **Step 3: Smoke manual**

Sequência com A1=música alta, A2=voz. Selecionar "Audio 2" (voz). Clicar Probe.
Expected: meanVolume reflete a voz (mais baixo), não a música. Threshold sugerido bate com a voz.

- [ ] **Step 4: Commit**

```bash
git add client/js/main.js
git commit -m "fix(probe): run volumedetect on mixdown wav instead of source file (bug #13)"
```

---

## Task 12: Per-clip media duration

Problema (bug #9): `<duration>` em todo clipitem usa `totalInputFrames` (duração da sequência). Spec FCP7 pede duração da **mídia-fonte** por clip.

**Files:**
- Modify: `host/index.jsx` — `getFullSequenceClips` retorna `mediaDurationSeconds` por clip
- Modify: `server/xmlGenerator.js` — usar `clip.mediaDurationSeconds` no lugar de `totalInputFrames`

- [ ] **Step 1: No host, ler duração do projectItem**

Em `getFullSequenceClips`, para cada clipe V/A:

```js
var mDur = 0;
try {
    if (pi.getOutPoint) {
        var op = pi.getOutPoint();
        if (op && typeof op.seconds === "number") mDur = op.seconds;
    }
} catch(e) {}
// Alternativa: pi.duration.seconds se existir
if (!mDur) {
    try { mDur = pi.duration.seconds; } catch(e) {}
}
// ... push:
clips.push({ /* ... */, mediaDurationSeconds: mDur });
```

- [ ] **Step 2: Adicionar teste em xmlGenerator**

```js
test("Clipitem duration uses per-clip mediaDurationSeconds (not sequence duration)", () => {
    const outPath = path.join(os.tmpdir(), `dct_test_${Date.now()}.xml`);
    generateFCP7XML({
        keepZones: [[0, 1]],
        sequenceClips: [{
            trackType: "video", trackIndex: 0, clipName: "shortclip",
            mediaPath: "C:/t/short.mp4", start: 0, end: 1, mediaIn: 0, mediaOut: 1,
            mediaDurationSeconds: 5,  // mídia tem só 5s
        }],
        sequenceName: "t", framerate: 30, exactFps: 30, isNTSC: false,
        xmlTimebase: 30, width: 1920, height: 1080, audioSampleRate: 48000,
        durationSeconds: 100,  // sequência tem 100s, mas clip só 5s
        outputPath: outPath, audioChannelCount: 2,
        audioTrackCount: 0, videoTrackCount: 1,
    });
    const xml = fs.readFileSync(outPath, "utf-8");
    fs.unlinkSync(outPath);

    // 5s @ 30fps = 150 frames — esse deve ser o <duration> do clipitem, não 3000
    const clipitemBlock = xml.split("<clipitem")[1].split("</clipitem>")[0];
    assert.ok(/duration>150</.test(clipitemBlock), "clipitem duration should be 150 (5s), not 3000");
});
```

- [ ] **Step 3: Rodar — esperado falhar**

Run: `npm test`
Expected: FAIL.

- [ ] **Step 4: Em xmlGenerator, usar per-clip duration**

Substituir nas duas ocorrências (video loop + audio loop) de:

```js
const fileDurFrames = totalInputFrames;
```

Por:

```js
const fileDurFrames = clip.mediaDurationSeconds
    ? toFrames(clip.mediaDurationSeconds)
    : totalInputFrames;  // fallback
```

Análogo para áudio: `const fileDurSamples = clip.mediaDurationSeconds ? toSamples(...) : totalInputSamples;`.

E no `fileDeclarations`, o `<duration>` de cada `<file>` deve usar a mesma lógica: escolher o primeiro clip que use aquele mediaPath e pegar sua `mediaDurationSeconds`.

- [ ] **Step 5: Rodar — esperado passar**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/xmlGenerator.js host/index.jsx tests/xmlGenerator.test.js
git commit -m "fix(xml): per-clip <duration> reflects source media, not sequence (bug #9)"
```

---

## Task 13: Per-clip media fps (bug #8)

Problema: `clip.mediaIn` em segundos convertido com fps da sequência produz número-de-frame inconsistente quando fps da mídia ≠ fps da sequência.

**Files:**
- Modify: `host/index.jsx` — incluir `mediaFps` por clip em `getFullSequenceClips`
- Modify: `server/xmlGenerator.js` — usar `mediaFps` do clip ao calcular `mediaIn`/`mediaOut`

- [ ] **Step 1: Host — adicionar `mediaFps` ao clip**

Em `getFullSequenceClips`:

```js
var mFps = 0;
try {
    // Tentativa: videoComponents[0].properties — varia por versão
    if (pi.videoComponents && pi.videoComponents.numItems > 0) {
        // fallback: deixar 0 se não conseguir. xmlGenerator usa seq fps nesse caso.
    }
    // Alternativa mais portável: pi.getFootageInterpretation().frameRate (PPro 14+)
    if (pi.getFootageInterpretation) {
        var fi2 = pi.getFootageInterpretation();
        if (fi2 && typeof fi2.frameRate === "number") mFps = fi2.frameRate;
    }
} catch(e) {}
// push:
clips.push({ /* ... */, mediaFps: mFps });
```

- [ ] **Step 2: xmlGenerator — usar `clip.mediaFps` para in/out da mídia**

Em `mapClipToOutput`, separar a conversão de `mediaIn` das conversões de `clip.start`/`clip.end`:

```js
const clipMediaTimebase = clip.mediaFps
    ? { timebase: Math.round(clip.mediaFps),
        isNTSC:   Math.abs(clip.mediaFps - Math.round(clip.mediaFps)) > 0.01 }
    : { timebase, isNTSC };

const cInF = secondsToFrames(clipMediaIn, clipMediaTimebase);
// cStartF, cEndF continuam no timebase da sequência (são posições da timeline)
```

(Nota: isso exige assinatura ampliada de `mapClipToOutput` — aceitar `clip.mediaFps` e calcular por clipe; considerar passar o objeto `clip` inteiro em vez de `(clipOrigStart, clipOrigEnd, clipMediaIn)`.)

- [ ] **Step 3: Teste**

Adicionar teste com `sequenceClips[0].mediaFps = 25` e `sequenceClips[0].mediaIn = 0.04` (1 frame @ 25fps). `cInF` esperado = 1 (não 1.2 arredondado para 1 por sorte).

- [ ] **Step 4: Rodar, ajustar, commit**

```bash
git add server/xmlGenerator.js host/index.jsx tests/xmlGenerator.test.js
git commit -m "fix(xml): use per-clip media fps for mediaIn/mediaOut frame conversion (bug #8)"
```

---

## Task 14: Validação final + atualização do vault

- [x] **Step 1: Rodar suite completa de testes unitários** ✅ 2026-04-25

Run: `npm test`
Expected: PASS em todos.
**Resultado**: 24/24 PASS (branch `fix/alignment-bugs`).

- [ ] **Step 2: Smoke test em todas as 4 sequências de referência**

Seguir roteiro da seção "Estratégia de validação". Preencher tabela:

```markdown
| Sequência | Modo | Desvio 1º corte | Desvio último | Observação |
|-----------|------|-----------------|---------------|------------|
| A 25fps   | All  |                 |               |            |
| A 25fps   | A1   |                 |               |            |
| B 29.97   | All  |                 |               |            |
| B 29.97   | A1   |                 |               |            |
| C 10min   | All  |                 |               |            |
| D mono+st | All  |                 |               |            |
| D mono+st | A1   |                 |               |            |
| D mono+st | A2   |                 |               |            |
```

Critério de aceite: todas ≤ 1 frame.

- [x] **Step 3: Atualizar vault — `Projetos/duckycut/todo.md`** ✅ 2026-04-25

Marcar como concluído o item "Validar fluxo AME + stable-size polling..." se aplicável. Adicionar entradas novas em "Concluído" com os IDs dos bugs fixados (#2, #3, #4, #5, #6, #7, #9, #13 e — se feito — #8).

- [x] **Step 4: Atualizar vault — `Projetos/duckycut/decisoes.md`** ✅ 2026-04-25

Adicionar ADR:

```markdown
## 2026-04-17 - Unificação de matemática de frames via server/frameMath.js
**Contexto**: `xmlGenerator` tinha fórmula própria `Math.round(s * exactFps)` que não era inversa da fórmula que Premiere usa ao LER o XML (`frame * 1001 / (1000 * timebase)` para NTSC). Resultado: drift acumulado em sequências longas.
**Decisão**: centralizar em `server/frameMath.js` com `secondsToFrames(s, { timebase, isNTSC })` usando `round(s * timebase * 1000 / 1001)` para NTSC. Áudio passa a ter módulo paralelo em samples.
**Alternativas descartadas**: (a) manter `exactFps` mas derivá-lo canonicamente como `timebase * 1000 / 1001` quando NTSC — funciona mas deixa duas fontes de verdade.
**Consequências**: round-trip idempotente; drift NTSC eliminado; dependência explícita entre clipes e formato NTSC da sequência.

## 2026-04-17 - Audio clipitem com timebase = sampleRate
**Contexto**: Spec FCP7 e bug #4 da análise.
**Decisão**: cada `<clipitem>` de áudio usa `<timebase>48000</timebase><ntsc>FALSE</ntsc>` e tempos em samples. Vídeo continua em frames.
**Consequências**: Premiere consegue re-importar sem inferir arredondamento sub-frame; áudio e vídeo mantêm sync dentro do clipe.

## 2026-04-17 - Single-track usa mixdown em sequence-time
**Contexto**: bug #2 — caminho "raw source file" em single-track rodava silencedetect em media-time e mapeava contra sequence-time.
**Decisão**: single-track passa a usar `detectSilenceFromSequence` com tracks filtradas. O caminho "raw source" foi removido.
**Consequências**: single-track exige ffmpeg para mix (já era o caso em All Tracks); mais uniforme e previsível.
```

- [x] **Step 5: Atualizar vault — `Projetos/duckycut/problemas-conhecidos.md`** ✅ 2026-04-25

Remover da lista de "Bugs conhecidos" (se adicionado) os agora corrigidos; adicionar em "Coisas que o usuário deve saber" se sobraram efeitos colaterais (ex.: single-track agora exige FFmpeg mesmo que o arquivo-fonte seja WAV — antes bastava FFmpeg pro silencedetect).

- [ ] **Step 6: Commit final**

```bash
git add "C:/Users/User/Documents/Obsidian/Main/Projetos/duckycut/todo.md" \
        "C:/Users/User/Documents/Obsidian/Main/Projetos/duckycut/decisoes.md" \
        "C:/Users/User/Documents/Obsidian/Main/Projetos/duckycut/problemas-conhecidos.md" 2>/dev/null || true
# nota: vault está em outro repo/fora do git do Duckycut — commit manual no vault se aplicável

git add docs/superpowers/plans/2026-04-17-correcao-desalinhamento.md
git commit -m "docs: phase 7 final validation results"
```

---

## Fora de escopo (plano futuro)

Bugs não cobertos por este plano, a tratar depois de validado:

- **Bug #10** (ticks em vez de seconds) — micro-otimização; só compensa se ainda sobrar drift sub-frame em sequências de 1h+.
- **Bug #11** (AME completion event) — já mitigado pelo polling de tamanho estável; fica como melhoria de robustez.
- **Bug #12** (timeout progressivo) — 1 linha de mudança; incluir junto com #11.
- **Bug #14** (sanitização paths com JSON.stringify) — baixo impacto prático; incluir em plano de hardening.
- **Bug #15** (warn project-not-saved no runAnalysis) — UX; 30 min.
- **Seção 16** (auto-load preset) — feature.
- **Seção 19** (melhorias não-bug: README, logs, cache probe, i18n) — plano próprio.

---

## Riscos e mitigações

| Risco | Mitigação |
|-------|-----------|
| `pi.getFootageInterpretation()` não existe em versões antigas de Premiere | Fallback para valores atuais (agregados) quando propriedade ausente; já previsto nos steps |
| Single-track passa a exigir FFmpeg sempre | Documentar em `problemas-conhecidos.md`; já exigia para silencedetect então na prática não muda nada |
| Teste `node --test` não disponível | Node 18+ traz nativo; `scripts/install.js` já usa Node moderno. Se falhar, trocar para `assert` puro + script driver — trivial |
| Mudança em `getActiveSequenceInfo` quebra consumidor antigo do painel | Campo `clips` é aditivo; nada remove campos existentes |
| ExtendScript ES3 não aceita `const`/arrow | Plan já instrui manter estilo ES3 em `host/index.jsx`; revisar cada step antes de aplicar |

---

## Resumo da proposta

10 tasks principais (+ 4 de setup/validação) para corrigir os 10 bugs mais críticos em 7 fases. Cada fase tem smoke test manual. Matemática de frames fica centralizada em um módulo novo (`server/frameMath.js`), áudio migra para timebase em samples, single-track passa a usar o mixdown em sequence-time que já existia mas não estava conectado. Esforço estimado: 10-14h de trabalho focado, sem contar smoke tests.

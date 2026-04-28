# Desalinhamento dos Cortes (Fluxo Razor) — Análise e Plano

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Identificar com precisão por que os cortes do `applyCutsInPlace` (razor + ripple-delete via QE DOM) estão landing em frames errados, instrumentar o pipeline para validar a hipótese, e aplicar a correção pontual.

**Architecture:** O fluxo atual NÃO usa mais XML. `runAnalysis` muta tracks não selecionadas, manda AME exportar a sequência inteira para WAV (`encodeSequence` modo `0` = ENCODE_ENTIRE), roda `silencedetect` no WAV, inverte silêncios em keepZones, inverte keepZones em cutZones, e em `applyCutsInPlace` (host) chama `razor(TC)` em cada faixa de V/A para cada cutZone, depois ripple-deleta clips fully-inside. O plano antigo `2026-04-17-correcao-desalinhamento.md` é **obsoleto** — todo o caminho XML foi removido em `f814073`.

**Tech Stack:** ExtendScript ES3 (host), CEP panel JS (Node 18 in-process), FFmpeg subprocess, QE DOM (`qe.project...razor()`).

---

## Análise — onde os tempos podem desalinhar

O caminho fonte → corte tem **5 conversões de tempo** que precisam ser consistentes:

| # | Onde | Domínio entrada | Domínio saída | Risco |
|---|------|-----------------|---------------|-------|
| A | AME `encodeSequence(seq, ENCODE_ENTIRE)` | sequence-time | WAV-time (0-based) | WAV pode começar em `seq.zeroPoint` ou em `0` absoluto, conforme versão PPro |
| B | FFmpeg `silencedetect` no WAV | WAV-time | float seconds (WAV-time) | OK, determinístico |
| C | `computeCleanCutZones` (panel) | float seconds | float seconds | sub-frame, sem snap |
| D | inversão keepZones→cutZones (panel:724-731) | float seconds | float seconds | sub-frame, sem snap |
| E | `_secondsToTimecodeHost(zStart + zpSec, fps, isNTSC)` (host:676-677) | seconds (WAV-time) + zpSec | string `HH:MM:SS:FF` | NDF/DF, ½ frame round, parsing de `seq.zeroPoint` |
| F | `qe...razor(tc)` | string TC | frame de corte real | depende de PPro interpretar TC com mesma convenção (NDF vs DF) |
| G | `_clipFullyInside(cs, ce, zStart, zEnd, fps)` (host:709,724) | `clip.start.seconds` (sequence-time) vs `zStart` (WAV-time) | bool | **Time-domain mismatch se zeroPoint ≠ 0** |

### Hipóteses de causa-raiz, ordenadas por probabilidade

**H1 — Parsing frágil de `seq.zeroPoint` (host:666-669) [P0]**

```jsx
var zpSec = 0;
try {
    var zpTicks = Number(seq.zeroPoint);
    if (!isNaN(zpTicks) && zpTicks > 0) zpSec = zpTicks / TICKS;
} catch (eZP) {}
```

`seq.zeroPoint` em ExtendScript pode retornar:
- string com ticks (ex.: `"914457600000"`) → `Number()` ok ✓
- `Time` object com `.ticks` e `.seconds` → `Number(timeObj)` retorna `NaN` ✗
- `0` ou string vazia para sequências começando em `00:00:00:00` ✓

Se for **Time object** (PPro 14+), `zpSec=0` mesmo com sequência iniciando em `01:00:00:00`. Razor TC vira `00:00:01:07` em vez de `01:00:01:07` → cuts caem em zona absurda fora dos clips → ripple-delete não acha clips → **APARENTEMENTE NADA ACONTECE** ou poucos cuts em poucas zonas que casualmente coincidem. Em sequências começando em zero (caso comum em projetos brutos), `zeroPoint=0` e isso passa despercebido — o bug só aparece em projetos broadcast.

**Sintoma esperado**: cuts perfeitos em sequência nova (zeroPoint=0); cuts deslocados por exatamente o offset do timecode-base em sequências com offset.

**H2 — `clip.start.seconds` vs zone bounds em time-domains diferentes (host:709,724) [P0 condicional em H1]**

`zStart`/`zEnd` estão em **WAV-time** (relativo a zeroPoint). `clip.start.seconds` no Premiere CEP retorna sequence-internal time **que JÁ é relativo ao início da sequência (sequence-time, não absoluto)** — i.e., `clip.start.seconds == 0` para o primeiro clip independente do `zeroPoint`. Isso faz com que **WAV-time == sequence-time** e `_clipFullyInside(cs, ce, zStart, zEnd)` esteja **correto**.

MAS: o razor TC é construído com `zStart + zpSec` (host:676), em time-domain absoluto-display. Se `zpSec` for calculado errado (H1), os razors caem em TC absurdo enquanto `_clipFullyInside` continua usando WAV-time correto → razor faz nada; clip-fully-inside encontra clip e DELETA com `clip.remove(true,true)` apesar de não ter razor → **deleta o clip inteiro, ripple machuca tudo**.

Esse é o cenário "tudo desalinha em cascata".

**H3 — Drop-frame vs non-drop-frame timecode (host:42-58) [P1]**

`_secondsToTimecodeHost` sempre emite `HH:MM:SS:FF` com `:` antes do FF. Premiere para sequência DF (29.97 drop-frame) usa `HH:MM:SS;FF` com `;`. `qe...razor(string)` aceita ambas, mas:

- DF: o parser pula 2 frames a cada minuto (não em min%10). NDF: não pula.
- Se a SEQUÊNCIA é DF e mandamos NDF, o frame onde o razor cai DESLIZA progressivamente: ~0 frames no início, +2 frames/min depois do 1º minuto, etc. Em uma timeline de 10 min isso vira ~18 frames de drift.

Pra NTSC integer fps (30, 60), NDF==DF e nada acontece. O bug só ocorre em sequências DF reais.

**H4 — Snap de fronteiras a frames antes da conversão para TC (panel:724-731 → host:676-677) [P1]**

`keepZones` saem do `computeCleanCutZones` como floats em segundos. cutZones são derivados invertendo, e mantém os mesmos floats. Em host, cada borda é arredondada INDEPENDENTE para o frame mais próximo (`Math.round(s * fps)` ou versão NTSC). Como `runAnalysis` em panel não snapa nada, fronteiras adjacentes a sub-frame podem cair em frames diferentes em pares "fim-da-keep" / "começo-do-cut" se a keepZone passar por padding etc. (na inversão atual, fim-da-keep[i] == começo-do-cut[i+1] no float, então arredondam pro mesmo frame — **provavelmente OK**). Risco real: ½-frame round em cada extremo desloca o cut em até ±½ frame absoluto.

Não é o "alinhamento errado óbvio", é o "às vezes 1 frame errado".

**H5 — AME WAV não começa em zeroPoint [P1]**

Empiricamente `encodeSequence(seq, ENCODE_ENTIRE)` exporta `[seq.zeroPoint, seq.end]`, com WAV t=0 == seq.zeroPoint. Isso significa que `silenceIntervals` saem em WAV-time (== sequence-time). Razor adiciona zpSec → display TC absoluto. Consistente.

Mas: algumas versões do AME podem renderizar a partir do **WORKAREA bar** ou do **In/Out point** se o usuário tem definidos. Modo `0` (ENCODE_ENTIRE) deve ignorar — o código já tem comentário sobre isso (host:362-364). Possível regressão entre versões.

Verificar: WAV duration vs (seq.end.seconds - zeroPoint). Se diferentes, AME ignorou ENCODE_ENTIRE.

**H6 — `clip.remove(true, true)` sem razor prévio (orphan delete) [P0 derivado de H1+H2]**

Se razor não cortou na borda da zona (porque TC errado por H1), mas `_clipFullyInside` enxerga um clip pequeno que está fully inside (porque tem tolerância de 1.5/fps), `clip.remove` ripple-deleta o clip INTEIRO (não só a parte na zona). Isso é a **geração contínua de desync**: cada zona "remove um pedaço grande demais" e o ripple junta tudo errado.

Caso típico: sequência tem clip de 60s, keep zone [10s, 20s] dentro dele, cutzones [0,10] e [20,60]. Razor não funciona → `_clipFullyInside([0,60], 0, 10, fps)` → false (clip não tá inside [0,10]). OK. Não deleta. Pode ser que esse caso esteja seguro, mas:

Caso problemático: razor parcial (algumas zonas razored, outras não), e clip pequeno (silêncio entre falas) está fully inside próxima zona pequena → deletado inteiro. Outras zonas falham silenciosamente. **Mistura de cuts certos + cuts ausentes** → desalinhamento crescente.

### Conclusão da análise

A **hipótese dominante é H1 (zeroPoint parsing)**, com **H6 como mecanismo amplificador** quando combinado a sequências broadcast. **H3 é uma 2ª causa independente** que afeta sequências DF reais. **H4 é refinamento sub-frame**.

O fix `cb28fd3` adicionou `zpSec` na conversão para TC — **correto na intenção**, mas a parsing usando `Number(seq.zeroPoint)` é onde o bug mora.

---

## Estratégia de validação

Sem testes UI/QE possíveis no Linux/CI. Estratégia em 3 camadas:

1. **Unitário**: testes `node:test` para `_secondsToTimecodeHost` (já existe? checar `tests/cutZones.test.js` cobre `secondsToTimecode`) e novas funções extraídas (`parseZeroPoint`).
2. **Diagnóstico**: instrumentar `applyCutsInPlace` para capturar `seq.zeroPoint` raw value, type, parsed `zpSec`, primeiro/último razor TC. Logar em `_diag` no retorno. Pedir ao usuário rodar e colar.
3. **Smoke manual** (Windows + PPro): 4 sequências de referência (zeroPoint=0 NTSC NDF, zeroPoint=0 25fps integer, zeroPoint=01:00:00:00 NTSC NDF, zeroPoint=0 NTSC DF se viável criar uma).

Diretórios:
- `tests/` — já existe; adicionar `tests/zeroPoint.test.js` e `tests/timecode.test.js`
- `host/index.jsx` — extrair helpers puros para módulo testável NÃO é viável (CEP carrega `.jsx` direto sem bundler); estratégia: copiar lógica em `client/js/cutZones.js` (já é dual-export) e testar lá.

Comando único: `npm test` (já configurado).

Critério de aceite global: em todas as 4 sequências, todo cut land ≤ 1 frame da posição esperada, sem drift crescente, sem cuts ausentes, sem cuts duplicados.

---

## Arquivos afetados

**Criar:**
- `tests/timecode.test.js` — testes de `secondsToTimecode` em NTSC/integer/DF
- `tests/zeroPoint.test.js` — testes de parser robusto de `seq.zeroPoint`

**Modificar:**
- `client/js/cutZones.js` — adicionar `parseZeroPoint(raw)` (puro, testável); adicionar `secondsToTimecode` variante drop-frame `secondsToDropTimecode`
- `host/index.jsx`:
  - função `_parseZeroPoint(seq)` substitui o `Number(seq.zeroPoint)` inline
  - `_secondsToTimecodeHost` aceita 4º argumento `isDropFrame` e emite `;` no separador final
  - `applyCutsInPlace` lê `isDropFrame` da sequência via QE DOM (`qeSeq.getSettings().dropFrameTimecode` ou similar) ou via campo extra em `seqSettings`
  - `applyCutsInPlace` retorna `_diag` enriquecido com `zeroPointRaw`, `zeroPointType`, `zpSec`, `isDropFrame`, primeiros 3 e últimos 3 razor TCs
- `client/js/main.js` — em `applyCutsInPlaceFromPanel`, snapar cutZones para frames antes de mandar pro host; loggar `_diag` no console pra inspeção
- `host/index.jsx` `getSequenceSettings` — incluir `isDropFrame` e `zeroPointSeconds` no retorno

---

## Task 1: Extrair `parseZeroPoint` puro e testar

**Files:**
- Modify: `client/js/cutZones.js`
- Create: `tests/zeroPoint.test.js`

- [ ] **Step 1: Escrever teste falhante**

```js
// tests/zeroPoint.test.js
const test   = require("node:test");
const assert = require("node:assert/strict");
const { parseZeroPoint } = require("../client/js/cutZones");

const TICKS = 254016000000;

test("string ticks: returns seconds", () => {
    // 1 hour @ 254016000000 ticks/sec = 914457600000 ticks
    assert.equal(parseZeroPoint("914457600000"), 3600);
});

test("number ticks: returns seconds", () => {
    assert.equal(parseZeroPoint(914457600000), 3600);
});

test("Time object with .ticks: returns seconds", () => {
    const fakeTimeObj = { ticks: "914457600000", seconds: 3600 };
    assert.equal(parseZeroPoint(fakeTimeObj), 3600);
});

test("Time object with only .seconds: returns seconds", () => {
    const fakeTimeObj = { seconds: 3600 };
    assert.equal(parseZeroPoint(fakeTimeObj), 3600);
});

test("zero / empty / null: returns 0", () => {
    assert.equal(parseZeroPoint(0), 0);
    assert.equal(parseZeroPoint("0"), 0);
    assert.equal(parseZeroPoint(""), 0);
    assert.equal(parseZeroPoint(null), 0);
    assert.equal(parseZeroPoint(undefined), 0);
});

test("negative ticks (PPro pre-roll): returns negative seconds", () => {
    assert.equal(parseZeroPoint(-914457600000), -3600);
});

test("garbage string: returns 0 (don't throw)", () => {
    assert.equal(parseZeroPoint("not-a-number"), 0);
    assert.equal(parseZeroPoint({}), 0);
});
```

- [ ] **Step 2: Rodar — esperado falhar**

Run: `npm test`
Expected: FAIL com `parseZeroPoint is not a function`.

- [ ] **Step 3: Implementar `parseZeroPoint` em `client/js/cutZones.js`**

Adicionar dentro do `factory()` antes do `return`:

```js
var TICKS_PER_SECOND = 254016000000;

function parseZeroPoint(raw) {
    if (raw === null || raw === undefined || raw === "") return 0;

    // Time object (PPro 14+): pega .seconds direto se existir, senão .ticks
    if (typeof raw === "object") {
        if (typeof raw.seconds === "number" && !isNaN(raw.seconds)) {
            return raw.seconds;
        }
        if (raw.ticks !== undefined) {
            var t = Number(raw.ticks);
            return isNaN(t) ? 0 : t / TICKS_PER_SECOND;
        }
        return 0;
    }

    // String ou number: assume ticks (convenção PPro pré-14)
    var n = Number(raw);
    if (isNaN(n)) return 0;
    return n / TICKS_PER_SECOND;
}
```

E no objeto retornado:

```js
return {
    computeSilenceCutZones: computeSilenceCutZones,
    secondsToTimecode:      secondsToTimecode,
    parseZeroPoint:         parseZeroPoint,
    _internals:             { mergeOverlapping: mergeOverlapping }
};
```

- [ ] **Step 4: Rodar — esperado passar**

Run: `npm test`
Expected: PASS em todos os testes (incluindo os existentes de `cutZones.test.js`).

- [ ] **Step 5: Commit**

```bash
git add client/js/cutZones.js tests/zeroPoint.test.js
git commit -m "feat(cutZones): add parseZeroPoint robust to Time object shapes"
```

---

## Task 2: Replicar `parseZeroPoint` em `host/index.jsx` e usar

ExtendScript não tem `require()` — precisa duplicar a função (mantida em sync com testes via cópia textual da Task 1).

**Files:**
- Modify: `host/index.jsx:36-67` (área de helpers); `host/index.jsx:665-669` (uso)

- [ ] **Step 1: Adicionar helper logo abaixo de `ticksToSeconds` (linha 40)**

```jsx
// Mirror of client/js/cutZones.js parseZeroPoint — keep in sync.
// seq.zeroPoint can be string ticks, number ticks, or Time object (PPro 14+).
function _parseZeroPoint(raw) {
    if (raw === null || raw === undefined || raw === "") return 0;
    if (typeof raw === "object") {
        try {
            if (typeof raw.seconds === "number" && !isNaN(raw.seconds)) return raw.seconds;
        } catch (e) {}
        try {
            if (raw.ticks !== undefined) {
                var t = Number(raw.ticks);
                return isNaN(t) ? 0 : t / TICKS;
            }
        } catch (e) {}
        return 0;
    }
    var n = Number(raw);
    if (isNaN(n)) return 0;
    return n / TICKS;
}
```

- [ ] **Step 2: Substituir bloco em `applyCutsInPlace` (linhas 665-669)**

Antes:

```jsx
var zpSec = 0;
try {
    var zpTicks = Number(seq.zeroPoint);
    if (!isNaN(zpTicks) && zpTicks > 0) zpSec = zpTicks / TICKS;
} catch (eZP) {}
```

Depois:

```jsx
var zpSec = 0;
var zpRaw = null, zpType = "";
try {
    zpRaw  = seq.zeroPoint;
    zpType = typeof zpRaw;
    zpSec  = _parseZeroPoint(zpRaw);
} catch (eZP) {}
```

- [ ] **Step 3: Adicionar `zpRaw`/`zpType`/`zpSec` ao `_diag` retornado**

No final de `applyCutsInPlace`, ANTES do `result += '}';` (linha 747), inserir:

```jsx
diag.push("zpRaw=" + (zpRaw === null ? "null" : String(zpRaw)));
diag.push("zpType=" + zpType);
diag.push("zpSec=" + zpSec);
diag.push("isNTSC=" + isNTSC + " fps=" + fps);
if (zones.length > 0) {
    var firstZone = zones[zones.length - 1]; // sorted descending, so last is earliest
    var lastZone  = zones[0];
    diag.push("firstZoneSec=[" + firstZone[0] + "," + firstZone[1] + "]");
    diag.push("firstZoneTC=[" + _secondsToTimecodeHost(firstZone[0] + zpSec, fps, isNTSC) + "," +
              _secondsToTimecodeHost(firstZone[1] + zpSec, fps, isNTSC) + "]");
    diag.push("lastZoneTC=[" + _secondsToTimecodeHost(lastZone[0] + zpSec, fps, isNTSC) + "," +
              _secondsToTimecodeHost(lastZone[1] + zpSec, fps, isNTSC) + "]");
}
```

- [ ] **Step 4: Smoke manual (Windows)**

1. Build/install: `npm run install-extension`
2. Abrir Premiere com sequência simples (zeroPoint=0).
3. Rodar Duckycut → Apply.
4. Inspecionar console do panel: deve aparecer `[Duckycut] applyCutsInPlace diag: [..., "zpRaw=...", "zpType=...", "zpSec=0", ...]`.
5. Repetir com sequência tendo zeroPoint = `01:00:00:00` (criar sequência iniciando em 1h).
6. Inspecionar `zpSec` — deve ser `3600` (não `0`!). Anotar `zpType` aqui (string? object?).

- [ ] **Step 5: Anotar resultados em `docs/superpowers/plans/2026-04-28-desalinhamento-razor-flow.md` no fim deste task**

```markdown
### Resultados Task 2 Step 4 (preencher):
- Seq zeroPoint=0:    zpType=___, zpSec=___, primeiro razor TC=___
- Seq zeroPoint=1h:   zpType=___, zpSec=___, primeiro razor TC=___, esperado=01:00:0X:XX
```

- [ ] **Step 6: Commit**

```bash
git add host/index.jsx docs/superpowers/plans/2026-04-28-desalinhamento-razor-flow.md
git commit -m "feat(host): robust zeroPoint parsing + diag instrumentation"
```

---

## Task 3: Detectar drop-frame timecode + emitir TC com separador correto

**Files:**
- Modify: `client/js/cutZones.js` — adicionar `secondsToDropTimecode`
- Create: `tests/timecode.test.js`
- Modify: `host/index.jsx` — `_secondsToTimecodeHost` aceita `isDropFrame`; `getSequenceSettings` retorna `isDropFrame`

- [ ] **Step 1: Teste falhante para drop-frame TC**

```js
// tests/timecode.test.js
const test   = require("node:test");
const assert = require("node:assert/strict");
const { secondsToTimecode, secondsToDropTimecode } = require("../client/js/cutZones");

test("NTSC 29.97 NDF: 60s → 59:28 (não-drop, atrasa relógio)", () => {
    // 60 real seconds @ 29.97 = round(60 * 30000/1001) = 1798 frames
    // 1798 / 30 = 59 sec + 28 frames
    assert.equal(secondsToTimecode(60, 29.97, true), "00:00:59:28");
});

test("NTSC 29.97 DF: 60s → 01:00:00 (drop-frame, casa com relógio real)", () => {
    // DF compensates by skipping 2 frames each minute (except every 10th).
    // After 60s real, DF reads ~01:00:00;00 (no drop yet because no minute crossed completed).
    // Actually at exactly minute boundary, drop happens at 01:00:00 → frames 00, 01 dropped.
    // round(60 * 30000/1001) = 1798 total frames; in DF labeling at 01:00:00;02.
    assert.equal(secondsToDropTimecode(60, 29.97), "00:01:00;02");
});

test("Integer 30fps: separator is colon regardless of DF flag", () => {
    assert.equal(secondsToTimecode(1, 30, false), "00:00:01:00");
});

test("DF round-trip: 600s → ~10:00", () => {
    // 600 real seconds @ 29.97 DF = should label as 10:00:00;00 (DF aligns with wall clock)
    var tc = secondsToDropTimecode(600, 29.97);
    assert.match(tc, /^00:10:00;0[0-2]$/);
});
```

- [ ] **Step 2: Rodar — esperado falhar**

Run: `npm test`
Expected: FAIL com `secondsToDropTimecode is not a function`.

- [ ] **Step 3: Implementar `secondsToDropTimecode` em `client/js/cutZones.js`**

```js
// 29.97 / 59.94 drop-frame timecode (SMPTE 12M).
// Skip 2 frames at start of every minute except every 10th minute.
// For 29.97 DF: skip = 2 frames; for 59.94 DF: skip = 4 frames.
function secondsToDropTimecode(seconds, fps) {
    if (!fps || fps <= 0) fps = 29.97;
    var nominalFps   = Math.round(fps);
    var dropPerMin   = (nominalFps === 60) ? 4 : 2;     // 59.94 vs 29.97
    var framesPer10m = nominalFps * 60 * 10 - dropPerMin * 9;
    var framesPerMin = nominalFps * 60        - dropPerMin;

    var totalFrames = Math.round(seconds * fps);

    var d = Math.floor(totalFrames / framesPer10m);
    var m = totalFrames %  framesPer10m;

    if (m > dropPerMin) {
        totalFrames = totalFrames + dropPerMin * 9 * d +
                      dropPerMin * Math.floor((m - dropPerMin) / framesPerMin);
    } else {
        totalFrames = totalFrames + dropPerMin * 9 * d;
    }

    var ff = totalFrames % nominalFps;
    var ss = Math.floor(totalFrames / nominalFps) % 60;
    var mm = Math.floor(totalFrames / (nominalFps * 60)) % 60;
    var hh = Math.floor(totalFrames / (nominalFps * 3600));

    function pad(n) { return n < 10 ? "0" + n : "" + n; }
    return pad(hh) + ":" + pad(mm) + ":" + pad(ss) + ";" + pad(ff);
}
```

E exportar:

```js
return {
    computeSilenceCutZones: computeSilenceCutZones,
    secondsToTimecode:      secondsToTimecode,
    secondsToDropTimecode:  secondsToDropTimecode,
    parseZeroPoint:         parseZeroPoint,
    _internals:             { mergeOverlapping: mergeOverlapping }
};
```

- [ ] **Step 4: Rodar — esperado passar**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Replicar `secondsToDropTimecode` em `host/index.jsx`**

Adicionar logo abaixo de `_secondsToTimecodeHost`:

```jsx
function _secondsToDropTimecodeHost(seconds, fps) {
    if (!fps || fps <= 0) fps = 29.97;
    var nominalFps   = Math.round(fps);
    var dropPerMin   = (nominalFps === 60) ? 4 : 2;
    var framesPer10m = nominalFps * 60 * 10 - dropPerMin * 9;
    var framesPerMin = nominalFps * 60      - dropPerMin;

    var totalFrames = Math.round(seconds * fps);
    var d = Math.floor(totalFrames / framesPer10m);
    var m = totalFrames % framesPer10m;
    if (m > dropPerMin) {
        totalFrames = totalFrames + dropPerMin * 9 * d +
                      dropPerMin * Math.floor((m - dropPerMin) / framesPerMin);
    } else {
        totalFrames = totalFrames + dropPerMin * 9 * d;
    }
    var ff = totalFrames % nominalFps;
    var ss = Math.floor(totalFrames / nominalFps) % 60;
    var mm = Math.floor(totalFrames / (nominalFps * 60)) % 60;
    var hh = Math.floor(totalFrames / (nominalFps * 3600));
    function pad(n) { return n < 10 ? "0" + n : "" + n; }
    return pad(hh) + ":" + pad(mm) + ":" + pad(ss) + ";" + pad(ff);
}
```

- [ ] **Step 6: Adicionar detecção de DF em `getSequenceSettings`**

Em `host/index.jsx:563-627`, adicionar antes do return:

```jsx
// ── Drop-frame detection ───────────────────────────────────────
var isDropFrame = false;
try {
    var s = seq.getSettings();
    if (s) {
        // PPro exposes drop-frame in different keys per version.
        if (typeof s.videoDisplayFormat === "number") {
            // 100 = 30fps DF, 102 = 60fps DF (per CEP enum)
            isDropFrame = (s.videoDisplayFormat === 100 || s.videoDisplayFormat === 102);
        }
    }
} catch (e) {}
// Fallback heuristic: if NTSC and not explicitly NDF, assume DF (PPro default)
if (!isDropFrame && isNTSC) {
    try {
        // QE DOM exposes a string format that includes "DF" or "Drop"
        app.enableQE();
        var qs = qe.project.getActiveSequence();
        if (qs && qs.getSettings) {
            var qss = qs.getSettings();
            if (qss && qss.videoFrameRate && /drop|DF/i.test(String(qss.videoFrameRate))) {
                isDropFrame = true;
            }
        }
    } catch (e) {}
}
```

E incluir `isDropFrame` no JSON retornado.

- [ ] **Step 7: Em `applyCutsInPlace`, ler `isDropFrame` de `opts` e usar TC correto**

No início de `applyCutsInPlace`:

```jsx
var isDropFrame = (typeof opts.isDropFrame === "boolean") ? opts.isDropFrame : false;
```

E substituir as duas chamadas a `_secondsToTimecodeHost` (linhas 676-677):

```jsx
var startTC, endTC;
if (isDropFrame) {
    startTC = _secondsToDropTimecodeHost(zStart + zpSec, fps);
    endTC   = _secondsToDropTimecodeHost(zEnd   + zpSec, fps);
} else {
    startTC = _secondsToTimecodeHost(zStart + zpSec, fps, isNTSC);
    endTC   = _secondsToTimecodeHost(zEnd   + zpSec, fps, isNTSC);
}
```

- [ ] **Step 8: Em `client/js/main.js`, repassar `isDropFrame` no optsArg**

Em `applyCutsInPlaceFromPanel` (linha 738-747):

```js
const fps    = (seqSettings && seqSettings.framerate)
            || (sequenceInfo && sequenceInfo.framerate) || 29.97;
const isNTSC = (seqSettings && typeof seqSettings.isNTSC !== "undefined")
            ? seqSettings.isNTSC
            : (sequenceInfo && sequenceInfo.isNTSC) || false;
const isDropFrame = (seqSettings && typeof seqSettings.isDropFrame === "boolean")
            ? seqSettings.isDropFrame : false;

// ...
const optsArg = JSON.stringify(JSON.stringify({
    fps: fps, isNTSC: isNTSC, isDropFrame: isDropFrame
}));
```

- [ ] **Step 9: Smoke manual**

Sequência DF (29.97 DF). Rodar Duckycut. Conferir cuts: timecodes devem usar `;` e cuts devem cair em frames esperados (não driftam por minuto).

- [ ] **Step 10: Commit**

```bash
git add client/js/cutZones.js tests/timecode.test.js host/index.jsx client/js/main.js
git commit -m "feat: drop-frame timecode support for razor() in DF sequences"
```

---

## Task 4: Snapar cutZones a frames antes de mandar pro host

Eliminar variabilidade sub-frame de `Math.round` independente entre `zStart` e `zEnd`.

**Files:**
- Modify: `client/js/main.js:724-731`

- [ ] **Step 1: Adicionar helper `snapToFrames` no escopo do IIFE de `main.js`**

Logo após o `function applyCutsInPlaceFromPanel()` (mas antes de seu corpo):

```js
function snapSecondsToFrame(seconds, fps, isNTSC) {
    if (!fps || fps <= 0) fps = 29.97;
    var nominalFps = Math.round(fps);
    var totalFrames;
    if (isNTSC) {
        totalFrames = Math.round(seconds * nominalFps * 1000 / 1001);
        return totalFrames * 1001 / (1000 * nominalFps);
    }
    totalFrames = Math.round(seconds * fps);
    return totalFrames / fps;
}
```

- [ ] **Step 2: Snapar `cutZones` antes de mandar**

Logo depois do bloco que monta `cutZones` (linha 731), e ANTES de `if (cutZones.length === 0)`:

```js
// Frame-snap zone boundaries to avoid asymmetric ½-frame rounding in host TC conversion.
const fpsForSnap    = (seqSettings && seqSettings.framerate)
                   || (sequenceInfo && sequenceInfo.framerate) || 29.97;
const isNTSCForSnap = (seqSettings && typeof seqSettings.isNTSC !== "undefined")
                   ? seqSettings.isNTSC
                   : (sequenceInfo && sequenceInfo.isNTSC) || false;
for (let i = 0; i < cutZones.length; i++) {
    cutZones[i][0] = snapSecondsToFrame(cutZones[i][0], fpsForSnap, isNTSCForSnap);
    cutZones[i][1] = snapSecondsToFrame(cutZones[i][1], fpsForSnap, isNTSCForSnap);
}
// Drop zero-width zones produced by snapping
const cutZonesNonEmpty = cutZones.filter(function (z) { return z[1] > z[0]; });
```

E usar `cutZonesNonEmpty` em vez de `cutZones` daqui pra baixo (no `if (cutZones.length === 0)` e no `JSON.stringify`).

- [ ] **Step 3: Smoke manual**

Sequência com keepZone que termine em sub-frame fracionário (vai naturalmente ocorrer com paddings de 100ms). Confirmar que cuts continuam landing 1:1 e não há regressão.

- [ ] **Step 4: Commit**

```bash
git add client/js/main.js
git commit -m "fix(panel): snap cut zone boundaries to frame grid before host (sub-frame round)"
```

---

## Task 5: Validar que AME WAV começa em zeroPoint (H5)

**Files:** nenhum a modificar — só validação.

- [ ] **Step 1: Adicionar log temporário em `runDetection` (panel:571-602)**

Logo após `silenceDetector.detectSilence` retornar, antes de `analysisResult = result`:

```js
console.log("[Duckycut] WAV duration =", result.mediaDuration,
            "| seq.duration =", (seqSettings && seqSettings.durationSeconds),
            "| seq.zeroPoint =", (seqSettings && seqSettings.zeroPointSeconds || 0),
            "| expected WAV =", ((seqSettings && seqSettings.durationSeconds) || 0) -
                                ((seqSettings && seqSettings.zeroPointSeconds) || 0));
```

(Requer expor `zeroPointSeconds` em `getSequenceSettings` — adicionar na Task 3 Step 6 ou aqui.)

- [ ] **Step 2: Rodar 2 sequências de smoke**

- Seq zeroPoint=0, 30s: log deve mostrar `WAV ≈ seq.duration ≈ 30`.
- Seq zeroPoint=1h, 30s (seq.end = 3630): log deve mostrar `WAV ≈ 30, seq.duration = 3630, expected WAV = 30`. Se WAV ≈ 3630, **AME está exportando absoluto, não a partir de zeroPoint** → bug separado, não coberto neste plano.

- [ ] **Step 3: Anotar resultados aqui**

```markdown
### Resultados Task 5 Step 2:
- Seq zp=0  30s:  WAV=___,  seq.duration=___,  match=Y/N
- Seq zp=1h 30s:  WAV=___,  seq.duration=___,  zeroPoint=___, expected WAV=___, match=Y/N
```

- [ ] **Step 4: Se H5 confirmada (mismatch), abrir issue/plano separado e remover log; se OK, remover log e commitar**

```bash
git add client/js/main.js host/index.jsx
git commit -m "chore: validate AME WAV start aligns with seq.zeroPoint"
```

---

## Task 6: Testes de regressão para o pipeline silence→cuts

**Files:**
- Create: `tests/cutInversion.test.js`

Cobre inversão keepZones→cutZones + frame-snap (Task 4) + delegação ao TC correto. Não substitui smoke; serve pra prevenir regressões nas mudanças de Task 1-4.

- [ ] **Step 1: Escrever testes**

```js
// tests/cutInversion.test.js
const test   = require("node:test");
const assert = require("node:assert/strict");
const { secondsToTimecode, secondsToDropTimecode, parseZeroPoint } = require("../client/js/cutZones");

test("zeroPoint=0 + cut at 1s NTSC NDF → 00:00:00:29 (frame 29)", () => {
    var zp = parseZeroPoint(0);
    assert.equal(zp, 0);
    assert.equal(secondsToTimecode(1 + zp, 29.97, true), "00:00:00:29");
});

test("zeroPoint=1h string ticks + cut at 1s NTSC NDF → 00:59:59:29 ou 01:00:00:00 (com NDF labels)", () => {
    var zp = parseZeroPoint("914457600000");  // 1h em ticks
    assert.equal(zp, 3600);
    var tc = secondsToTimecode(1 + zp, 29.97, true);
    // 3601s @ 29.97 NDF: round(3601 * 30000/1001) = round(107922.077) = 107922 frames
    // 107922 / 30 = 3597 sec + 12 frames; 3597 sec = 59 min + 57 sec
    // tc = 00:59:57:12 (NDF: timecode atrasa em relação ao real)
    assert.equal(tc, "00:59:57:12");
});

test("zeroPoint=1h Time object: same as string", () => {
    var fakeTime = { ticks: "914457600000", seconds: 3600 };
    assert.equal(parseZeroPoint(fakeTime), 3600);
});
```

- [ ] **Step 2: Rodar — esperado passar (todos os blocos já implementados em Tasks 1+3)**

Run: `npm test`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/cutInversion.test.js
git commit -m "test: regression tests for zeroPoint+TC pipeline"
```

---

## Task 7: Smoke test manual final + tabela de aceite

- [ ] **Step 1: Rodar smoke nas 4 sequências**

| Sequência | fps | DF? | zeroPoint | Esperado |
|-----------|-----|-----|-----------|----------|
| A | 25 | N/A | 00:00:00:00 | ≤ 1 frame de erro em qualquer corte |
| B | 29.97 NDF | NÃO | 00:00:00:00 | ≤ 1 frame |
| C | 29.97 DF | SIM | 00:00:00:00 | ≤ 1 frame, sem drift por minuto |
| D | 29.97 DF | SIM | 01:00:00:00 | ≤ 1 frame, no TC absoluto |

- [ ] **Step 2: Para cada uma, anotar:**

```markdown
| Seq | 1º cut esperado | 1º cut observado | último esperado | último observado | razor diag (zpType, zpSec, isDropFrame) |
|-----|-----------------|------------------|-----------------|------------------|-----------------------------------------|
| A   |                 |                  |                 |                  |                                         |
| B   |                 |                  |                 |                  |                                         |
| C   |                 |                  |                 |                  |                                         |
| D   |                 |                  |                 |                  |                                         |
```

- [ ] **Step 3: Se aceite OK em todas: commit**

```bash
git add docs/superpowers/plans/2026-04-28-desalinhamento-razor-flow.md
git commit -m "docs: alignment regression smoke test results"
```

- [ ] **Step 4: Se Seq D falhar (zeroPoint não aplicou): re-debug `_diag.zpRaw`/`zpType` e iterar Task 1**

Documentar formato real de `seq.zeroPoint` que apareceu, atualizar `parseZeroPoint` se necessário.

---

## Riscos e mitigações

| Risco | Mitigação |
|-------|-----------|
| `seq.getSettings().videoDisplayFormat` enum varia entre versões PPro | Fallback heurística por NTSC + tentativa via QE; documentar versões testadas |
| Sequências sem QE DOM acessível | `enableQE()` wrap com try/catch — já é o padrão; falha grace |
| `secondsToDropTimecode` pode ter erro de borda em minuto-cruzamento | Testes unitários cobrem 60s, 600s; smoke manual valida mais |
| `_parseZeroPoint` em ExtendScript precisa ficar em sync com versão JS | Comentário no host aponta para o módulo; convém adicionar `tests/parity.test.js` que lê o source de ambos e diffa o corpo da função (skip pra agora — YAGNI) |
| Snap de cutZones pode criar zonas de comprimento zero quando padding gera keepZones colados | Filtrar com `cutZonesNonEmpty` (Task 4 Step 2); empty ⇒ skip |
| AME WAV não começa em zeroPoint (H5 confirmada) | Plano separado; sai do escopo daqui |

---

## Fora de escopo

- Razor parcial → ripple delete inconsistente (H6) — fica resolvido implicitamente quando H1 e H3 forem corrigidas; não há work item separado, mas a tabela de aceite valida.
- AME export fontes/handles/workarea (H5) — plano novo se confirmado.
- Snap de keepZones a frame ANTES de gerar cutZones — Task 4 já cobre fazendo no cutZones (mais perto do uso).

---

## Resumo

7 tasks, 4 frentes: **(a) parsing robusto de `seq.zeroPoint`** (Tasks 1-2, P0, suspeita primária), **(b) drop-frame timecode** (Task 3, P1, segunda causa independente), **(c) snap a frames** (Task 4, P2, refinamento sub-frame), **(d) validação de AME WAV** (Task 5, descoberta). Tasks 6-7 são regressão e aceite. Esforço estimado: 6-9h trabalho focado, 2h smoke. Cada task é commit independente; pode pausar entre tasks sem deixar build quebrada.

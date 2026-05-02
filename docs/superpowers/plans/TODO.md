# Duckycut — Plano Consolidado de Pendências

Mescla itens não concluídos dos planos anteriores (`2026-04-17` XML, deletado; `2026-04-28` razor-flow, deletado). Só itens ainda relevantes pro código atual.

---

## 1. Smoke / validação Windows + Premiere (bloqueia merge final)

Código dos commits `b3954f4..28deb7e` (parseZeroPoint, drop-frame TC, snap-to-frame, diag) está em `main` mas NÃO foi validado em PPro real. Linux+CI não rodam Premiere.

**Roteiro mínimo — 4 sequências:**

| Seq | fps | DF | zeroPoint | Esperado |
|-----|-----|----|-----------|----------|
| A | 25 integer | n/a | `00:00:00:00` | cuts ≤ 1 frame de erro |
| B | 29.97 NDF | não | `00:00:00:00` | ≤ 1 frame, TC com `:` antes de FF |
| C | 29.97 DF | sim | `00:00:00:00` | ≤ 1 frame, sem drift por minuto, TC com `;` |
| D | 29.97 DF | sim | `01:00:00:00` | ≤ 1 frame, razor lança em `01:00:0X;FF` (não em `00:00:0X`) |

**Como ler `_diag` (DevTools console do panel):**
- `zpType=object` + `zpSec=3600` em Seq D → fix funcionou
- `zpType=object` + `zpSec=0` em Seq D → `_parseZeroPoint` precisa novo branch (anotar shape de `seq.zeroPoint` retornado e ajustar)
- `zpType=string` + `zpSec=3600` → caminho legado, OK
- `isDropFrame=true` em Seq C/D, `false` em A/B → detecção correta
- `firstZoneTC` / `lastZoneTC` com `;` em DF, `:` em NDF → branch correto

**Tabela de aceite (preencher):**

```
| Seq | zpType | zpSec | isDropFrame | 1º razor TC | último razor TC | Visual: cuts no frame esperado? |
|-----|--------|-------|-------------|-------------|-----------------|--------------------------------|
| A   |        |       |             |             |                 |                                |
| B   |        |       |             |             |                 |                                |
| C   |        |       |             |             |                 |                                |
| D   |        |       |             |             |                 |                                |
```

Critério aceite global: ≤ 1 frame em todas. Se Seq D falhar, ver bloco "WAV start" abaixo antes de mexer em parseZeroPoint.

---

## 2. Validar que WAV direto começa em zeroPoint (diagnóstico H5)

Premissa atual: `exportAsMediaDirect(..., ENCODE_ENTIRE)` exporta `[seq.zeroPoint, seq.end]` e WAV t=0 == zeroPoint. Não testado empiricamente — algumas versões PPro podem ignorar e exportar absoluto.

**Validação:** adicionar log temporário em `client/js/main.js` `runDetection`, ANTES de `analysisResult = result`:

```js
console.log("[Duckycut] WAV duration =", result.mediaDuration,
            "| seq.duration =", (seqSettings && seqSettings.durationSeconds),
            "| seq.zeroPoint =", (seqSettings && seqSettings.zeroPointSeconds || 0),
            "| expected WAV =", ((seqSettings && seqSettings.durationSeconds) || 0) -
                                ((seqSettings && seqSettings.zeroPointSeconds) || 0));
```

Rodar Seq D (zp=1h, duração 30s):
- WAV ≈ 30 → premissa OK
- WAV ≈ 3630 → export direto ignora ENCODE_ENTIRE → bug separado, abrir issue dedicada

Remover log depois.

---

## 3. Probe simples no arquivo-fonte — concluído 2026-05-01

`client/js/main.js:runProbe` chama `getAudioTrackMediaPath(firstSelected)` e roda `volumedetect` no arquivo bruto da PRIMEIRA clip. Limitações aceitas:
- Se A1 selecionada tem 5 clips de origens distintas, calibra só pelo 1º
- Se usuário seleciona "Audio 2" que tem música, threshold sai calibrado pra música em vez da voz que ele realmente quer cortar
- Não respeita mute/efeitos da sequência

**Decisão atual:** manter o `Auto Detect` simples e rápido, sem render/prerender. Ele serve só como calibração inicial de speech level. O render direto e a validação de duração ficam no `Analyze`, onde as faixas selecionadas precisam ser tratadas como um único mix.

---

## 4. Removidos / não fazer

- ~~Tudo de `2026-04-17-correcao-desalinhamento.md` Tasks 2-13~~ — XML flow removido (`f814073`); fixes não aplicam mais ao panel. `server/xmlGenerator.js` ainda existe pro server HTTP standalone (`server/index.js`), mas esse caminho não é o user-facing.
- ~~Tasks 1-4, 6 do plano `2026-04-28`~~ — implementado em `b3954f4..5d60ab8`.
- ~~Hardening baixo impacto~~ — README criado, `npm test` corrigido para Windows, `exportSequenceAudio` usa `JSON.stringify` nos paths e `runAnalysis` bloqueia projeto não salvo. Cache por `mediaPath+mtime`, i18n, auto-load de preset, logs estruturados e per-clip metadata não são pertinentes ao fluxo user-facing atual.

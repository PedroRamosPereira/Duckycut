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

Critério aceite global: ≤ 1 frame em todas. Se Seq D falhar, ver bloco "AME WAV start" abaixo antes de mexer em parseZeroPoint.

---

## 2. Validar que AME WAV começa em zeroPoint (diagnóstico H5)

Premissa atual: `encodeSequence(seq, ENCODE_ENTIRE)` exporta `[seq.zeroPoint, seq.end]` e WAV t=0 == zeroPoint. Não testado empiricamente — algumas versões PPro podem ignorar e exportar absoluto.

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
- WAV ≈ 3630 → AME ignora ENCODE_ENTIRE → bug separado, abrir issue dedicada

Remover log depois.

---

## 3. Probe no mixdown, não no arquivo-fonte

`client/js/main.js:runProbe` (linha ~369) chama `getAudioTrackMediaPath(firstSelected)` e roda `volumedetect` no arquivo bruto da PRIMEIRA clip. Problemas:
- Se A1 selecionada tem 5 clips de origens distintas, calibra só pelo 1º
- Se usuário seleciona "Audio 2" que tem música, threshold sai calibrado pra música em vez da voz que ele realmente quer cortar
- Não respeita mute/efeitos da sequência

**Fix proposto:** reutilizar pipeline AME do `runAnalysis`. Extrair helper `ensureMixdown(selectedIndices) → Promise<wavPath>`:
1. Mute tracks não selecionadas
2. `exportSequenceAudio` → poll stable size
3. Restore mutes
4. Resolve com `tempWav`

Então `runProbe` chama `ensureMixdown([selectedFirst])` → `probeAudio(tempWav)` em vez do `getAudioTrackMediaPath` direto.

Custo: probe fica mais lento (espera AME). Vale: threshold passa a refletir mix real.

Esforço: ~2h. Toca só `client/js/main.js`.

---

## 4. Hardening (baixa prioridade, sem dependência alinhamento)

| Item | Onde | Esforço |
|------|------|---------|
| Auditar chamadas restantes de `evalScript("...")` que aceitam input externo; `exportSequenceAudio` já usa helper `jsxStringArg()` + `JSON.stringify` | `client/js/main.js` | 30min |
| Warn "project not saved" no início de `runAnalysis` (`getProjectPath` retorna error) — hoje só falha em `savePreset` | `client/js/main.js:runAnalysis` | 30min |
| Cache `probeResult` por `mediaPath+mtime` pra evitar re-probe | `client/js/main.js` | 1h |
| Logs estruturados (níveis info/warn/error) em vez de `console.log` solto | `client/js/main.js` | 1h |

---

## 5. Considerar / talvez nunca

- **i18n** — UI hoje em inglês fixo. Pequena base. Pula até ter user feedback.
- **Auto-load preset** ao abrir painel se existe `duckycut_preset_*.json` no projectDir. Pequeno UX win.
- **Per-clip media metadata** (`mediaDurationSeconds`, `mediaFps`, `srcChannels`) em `getFullSequenceClips`. Era P3 do plano XML antigo. Hoje **não usado** porque XML flow morreu. Re-considerar SE algum dia voltar fluxo XML ou se panel precisar dessa info.

---

## 6. Removidos / não fazer

- ~~Tudo de `2026-04-17-correcao-desalinhamento.md` Tasks 2-13~~ — XML flow removido (`f814073`); fixes não aplicam mais ao panel. `server/xmlGenerator.js` ainda existe pro server HTTP standalone (`server/index.js`), mas esse caminho não é o user-facing.
- ~~Tasks 1-4, 6 do plano `2026-04-28`~~ — implementado em `b3954f4..5d60ab8`.

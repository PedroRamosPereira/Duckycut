# Duckycut

Extensao CEP para Adobe Premiere Pro que detecta silencio com FFmpeg e aplica cortes na timeline do Premiere. Inspirado no fireCut.

## Requisitos

- Adobe Premiere Pro com suporte a CEP (`PPRO 14+`).
- Preset WAV disponivel no Premiere/MediaCore para renderizar o mixdown WAV da sequencia.
- FFmpeg disponivel no `PATH`.
- Node.js para instalar a extensao em modo desenvolvimento e rodar testes.

## Instalar Em Desenvolvimento

```bash
npm run install-extension
```

No Windows, habilite extensoes CEP sem assinatura criando `PlayerDebugMode=1` em `HKEY_CURRENT_USER\SOFTWARE\Adobe\CSXS.11`, reinicie o Premiere e abra `Window > Extensions > Duckycut`.

## Uso Basico

1. Abra uma sequencia no Premiere.
2. Selecione as tracks de audio que entram na analise.
3. Clique `Auto Detect` para calibrar volume.
4. Clique `Analyze` para renderizar um WAV pelo Premiere.
5. Ajuste as configuracoes manuais na tela seguinte.
6. Clique `Apply Cuts`; nesse momento o FFmpeg detecta silencios com a configuracao atual e, em seguida, aplica os cortes in-place.

O `Analyze` usa `exportAsMediaDirect()` como caminho principal: antes do render, o host tenta mutar as tracks nao selecionadas e desmutar as selecionadas; depois sempre restaura os mutes originais. Em `Full Sequence`, o export usa `workAreaType=0`. Em `Range: In-Out`, usa `workAreaType=1`. O `silencedetect` roda depois, no clique de `Apply Cuts`, usando o WAV ja renderizado e os sliders atuais.

## Testes

```bash
npm test
```

Os testes automatizados cobrem matematica de timecode, zeroPoint, cut zones e o caminho de export direto via Premiere. Smoke tests reais ainda precisam rodar no Premiere, porque CEP, QE DOM e `exportAsMediaDirect` dependem do aplicativo Adobe.

## Smoke Test Manual Minimo

Validar quatro sequencias no Premiere:

| Seq | FPS | Drop-frame | ZeroPoint | Esperado |
|-----|-----|------------|-----------|----------|
| A | 25 | n/a | `00:00:00:00` | cortes com erro <= 1 frame |
| B | 29.97 | nao | `00:00:00:00` | timecode NDF com `:` |
| C | 29.97 | sim | `00:00:00:00` | sem drift por minuto, timecode com `;` |
| D | 29.97 | sim | `01:00:00:00` | razor no offset de 1h, nao em 0h |

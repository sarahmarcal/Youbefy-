# Testes do Youbefy

Validação gratuita da lógica principal, sem Google Cloud, sem OAuth e sem Chrome.
Só precisa do Node (v18+), sem `npm install`.

```
node tests/run.mjs            # testes offline + testes ao vivo (youtube.com)
node tests/run.mjs --offline  # só os testes offline, sem rede
```

**O que valida:** o `background.js` roda num contexto `node:vm` com um `chrome` falso.
Offline: cache de vídeos (`cachedVideoId`, `saveCache`), `parseFragment`,
`buildWatchVideosUrls` e `convertPlaylist` no modo gratuito (sem nenhuma chamada a
googleapis/accounts.google.com). Ao vivo: `scrapeVideoId` contra ~12 músicas reais
(MPB, sertanejo, pop, K-pop...), com título e canal conferidos via oEmbed, e um link
`watch_videos` que precisa redirecionar para uma playlist temporária (`list=TLGG...`).
O link final é impresso para você abrir e ouvir. Testes marcados `SKIP` dependem de
funções que ainda não existem no `background.js`; o código de saída é 1 se algo falhar.

**O que NÃO cobre (precisa do navegador):** a leitura da playlist na página do
Spotify (`contentScript.js`, incluindo a rolagem) e o caminho real com OAuth +
YouTube Data API (login, criação de playlist, cota).

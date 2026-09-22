# Clubes do Minicamp

133 clubes, revisados em 22/09/2026. Mantidos os 28 escolhidos pelo administrador e os três acréscimos anteriores (São Paulo, Club América, CD Guadalajara).

A ampliação usa os clubes listados no banco comunitário PES Master para eFootball. Nomes exibidos no jogo podem ser genéricos ou variar conforme modo, plataforma e atualização. Não se trata de certificação individual de licença pela Konami.

Fontes consultadas:
- https://www.konami.com/efootball/pt-br/page/license_efootball
- https://www.pesmaster.com/english-league/efootball-2022/league/113/
- https://www.pesmaster.com/lega-italia/efootball-2022/league/116/
- https://www.pesmaster.com/spanish-league/efootball-2022/league/119/
- https://www.pesmaster.com/ligue-1-mcdonalds/efootball-2022/league/122/
- https://www.pesmaster.com/liga-portugal-betclic/efootball-2022/league/128/
- https://www.pesmaster.com/vriendenloterij-eredivisie/efootball-2022/league/125/

Aliases já existentes preservados, sem duplicar: Milan/AC Milan, Internazionale/Inter, Atalanta/Atalanta BC, Barcelona/FC Barcelona, Lyon/Olympique Lyonnais, Porto/FC Porto, Benfica/SL Benfica, Sporting CP/Sporting.

A migração 009 só acrescenta clubes ao catálogo. Não altera os clubes já atribuídos, partidas ou estatísticas. O sorteio não repete clubes dentro da mesma Copa; entre edições, repetições continuam possíveis.

## Diagnóstico

`!teste`: configuração da Copa, vagas, confirmações e contestações, sem criar jogos.
`!supabase`: leitura e gravação do evento no banco, tempo de processamento e resposta pelo fluxo normal. Sucesso descreve aquele momento; ausência de resposta não significa aprovação.

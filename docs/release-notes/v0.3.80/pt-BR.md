Esta versão torna a página de plugins em destaque do ECPA de fato utilizável: as descrições agora seguem o idioma da interface, os plugins instalados mostram lançamentos mais novos e atualizam no lugar, a página ganhou um botão de atualização manual, e o catálogo incluído agora traz o FreeTier 2API. Também corrige dois erros de cálculo na média de TPS da página de uso.

Se encontrar problemas, avise no [Discord](https://discord.gg/your-discord-invite) ou abra uma issue no [GitHub](https://github.com/router-for-me/EasyCLIProxyAPI/issues).

## Novidades

- **Plugins em destaque atualizam no lugar**: os plugins em destaque já instalados resolvem o lançamento mais recente no GitHub ao carregar. Quando existe uma versão mais nova, o rótulo de versão mostra “atual → mais recente” e o cartão exibe o selo “Atualização disponível” e um botão Atualizar, que baixa e instala o lançamento. O selo some assim que a instalação termina. Plugins que já estão no lançamento mais recente mantêm o selo simples Instalado.
- **Atualização manual na página de plugins em destaque**: um botão Atualizar ao lado da caixa de pesquisa obtém de novo o catálogo em destaque, ignorando o cache local, e atualiza ao mesmo tempo a lista de fontes de plugins, então uma atualização do catálogo não exige mais esperar o cache expirar nem reiniciar o aplicativo.
- **As descrições dos plugins seguem o idioma da interface**: as entradas em destaque agora usam a descrição localizada fornecida pelo catálogo. Uma interface em chinês simplificado mostra o texto em chinês, o chinês tradicional usa o texto do chinês simplificado quando falta a tradução própria, e os demais idiomas usam o padrão do catálogo.

## Correções

- **A média de TPS não é mais puxada para baixo por solicitações com falha**: a estatística de vazão de uso incluía solicitações com falha na média. Agora ela conta apenas as solicitações bem-sucedidas.
- **TPS calculado por solicitação**: a vazão agora deriva da própria contagem de tokens de saída e da latência de cada solicitação, em vez de dividir um total do período, então o número acompanha a velocidade real da resposta.

## Melhorias

- **O catálogo em destaque incluído traz o FreeTier 2API**: quando a rede está indisponível, o aplicativo usa o catálogo incluído. Esses dados agora também trazem o FreeTier 2API, então a página não se reduz mais a um único plugin.

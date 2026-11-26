Esta versão trata de uma coisa só na página de plugins em destaque do ECPA: ser utilizável à primeira vista. Os cartões e os botões de instalação já podem ser usados assim que a página é desenhada, em vez de ficarem cinza atrás de uma cadeia de chamadas de inicialização. Uma instalação concluída mostra Instalado na hora. Os plugins instalados mostram um lançamento mais novo com Atualizar em um clique. E, quando o endpoint da loja de plugins fica temporariamente indisponível, a página agora usa os dados do catálogo incluído, em vez de uma parede de botões cinza. O núcleo incluído passa para 8.0.59.

Se encontrar problemas, avise no [Discord](https://discord.gg/your-discord-invite) ou abra uma issue no [GitHub](https://github.com/router-for-me/EasyCLIProxyAPI/issues).

## Melhorias

- **A página de plugins em destaque já pode ser usada ao abrir**: os cartões são desenhados primeiro a partir do catálogo incluído, e o botão de instalação espera apenas a listagem de plugins, sem mais entrar na fila atrás da sondagem de suporte, do registro da fonte de plugins e da consulta de versão. Enquanto a listagem ainda está em andamento, o botão aparece como carregando, em vez de um botão cinza sem explicação.
- **A consulta de versão foi para segundo plano**: as versões mais recentes são preenchidas depois que a página já pode ser usada, então atualizar as versões não pode mais deixar o botão cinza de novo.

## Correções

- **O estado Instalado aparece assim que a instalação é bem-sucedida**: antes, uma instalação concluída só mudava de cor depois que a listagem de plugins era atualizada, e podia até voltar ao botão de instalar nesse intervalo. Uma instalação bem-sucedida agora mostra Instalado na hora e permanece assim durante a sessão, sem ser sobrescrita por uma listagem desatualizada.
- **Plugins instalados mostram atualizações**: o selo de atualização e o botão Atualizar agora derivam da versão instalada e da mais recente do catálogo, tratando o prefixo `v` e números de versão de prévia, então plugins instalados de outra fonte também são reconhecidos e atualizados.
- **Sem parede cinza quando o endpoint da loja de plugins falha**: quando a listagem da loja falha e não devolve entradas, a página monta entradas instaláveis a partir dos dados de catálogo que já tem, registra a fonte de plugins, tenta a instalação mais uma vez e mostra o erro, em vez de deixar o botão silenciosamente sem clique.

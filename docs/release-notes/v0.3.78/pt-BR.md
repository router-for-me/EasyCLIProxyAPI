Esta versão torna a central de plugins utilizável desde a primeira abertura, corrige a instalação de plugins pela loja e o aviso de atualização que faltava depois de trocar o canal de atualização numa compilação formal, e inclui o núcleo empacotado mais recente, encaminhando os downloads manuais pelo espelho selecionado.

Se encontrar problemas, avise no [Discord](https://discord.gg/your-discord-invite) ou abra uma issue no [GitHub](https://github.com/router-for-me/EasyCLIProxyAPI/issues).

## Novidades

- **Os plugins em destaque do ECPA funcionam de imediato**: abrir a página Plugins agora registra a fonte do ECPA automaticamente, então não há mais um botão para pressionar nem uma faixa permanente de “fonte registrada”. Os estados de carregamento, vazio e erro na aba de destaque foram refeitos, para que uma fonte indisponível explique o motivo em vez de apenas dizer que o plugin não foi encontrado.
- **A loja de plugins instala pelas fontes registradas**: os plugins em destaque agora passam pelo fluxo compartilhado de instalação, com progresso, motivos de falha e estado instalado.
- **Formulário de criação de alias de modelo**: os aliases podem ser criados na interface escolhendo o modelo original e um modo de velocidade, com o alias gerado automaticamente, sem editar a configuração à mão.
- **Notas nas contas de cota**: as linhas de cota podem ter uma nota, e o editor agora é um campo sublinhado no próprio lugar, em que adicionar e limpar acontecem ali mesmo, sem um diálogo.
- **Visibilidade de modelos do Codex em lote**: vários modelos podem ser ativados ou ocultados de uma vez, e a página de cotas ganhou a exibição compacta.

## Correções

- **Sem botão de atualização depois de trocar o canal de atualização**: compilações com carimbo de data e hora usam versões como `0.3.6-preview.20261106-1137`, que o versionamento semântico sempre classifica abaixo de `0.3.6`, então trocar uma compilação formal para outro canal de atualização informava “nenhuma atualização disponível” e só oferecia um botão de download. Essas compilações agora são reconhecidas como uma versão mais nova, e a atualização no aplicativo aparece depois da troca de canal.
- **Downloads manuais ignoravam a fonte de download selecionada**: o botão de download abria a URL bruta do artefato no GitHub a partir do manifesto, então o espelho selecionado só afetava a busca da lista de versões. O link de download agora aplica o prefixo do espelho selecionado.
- **Sem entrada de configurações a partir da central de plugins**: o token do GitHub era informado num painel recolhível na página de plugins. Um link de texto leve agora vai direto para Gerenciamento de configuração → Acesso e autenticação → Token global do GitHub, e as dicas de limite de taxa também apontam para lá.
- **O botão de link do cartão de plugin era pequeno demais**: era um botão de ícone minúsculo e agora é um botão normal, com rótulo visível e área de toque de pelo menos 32px.
- **O diálogo de confirmação do roteamento não combinava com o resto do aplicativo**: aplicar alterações de roteamento abria um formulário sequencial simples. Agora ele usa o mesmo diálogo do aviso de fechar a janela, com uma lista de alterações com borda, linhas alinhadas e as ações num rodapé fixo.
- **Os gráficos de uso cortavam rótulos largos do eixo**: rótulos como marcas com prefixo de moeda eram cortados na borda do gráfico. A margem agora é dimensionada a partir do rótulo mais largo do idioma atual.
- **A validação do preset do ZCode falhava**: a especificação da opção `maxOutputTokens` trazia um campo de mapa inválido que quebrava a validação da configuração desse provedor. Ele foi removido.

## Melhorias

- **Núcleo incluído atualizado para 8.0.58**: os pacotes de lançamento agora trazem o núcleo mais recente, então uma instalação nova já o executa desde a primeira abertura.
- **Palavras sensíveis padrão do DeepSeek Harness**: a lista padrão de palavras sensíveis do Devin agora inclui o DeepSeek Harness.
- **Explicação mais clara do canal**: a descrição, na página de versões, das compilações formais em comparação com as que têm carimbo de data e hora foi reescrita, e as compilações passam a ser distinguidas pelo horário da compilação.

## Melhorias

- Refinado o layout da área de trabalho da Configuração de agentes. A lista de clientes e o painel de configuração agora mantêm proporções mais claras no desktop, as abas permanecem fixas acima do conteúdo com rolagem independente e janelas estreitas continuam usando rolagem natural da página.
- Melhorados a rolagem da lista de clientes e o layout do texto para que nomes longos, versões e detalhes de status permaneçam legíveis em qualquer tamanho de janela.
- O eixo X da tendência de Token agora responde de forma mais suave à largura da janela. A densidade das marcações aumenta ou diminui progressivamente ao redimensionar a janela, evitando rótulos esparsos demais ou repentinamente aglomerados.
- Atualizado o núcleo incluído para a versão 7.3.12.

## Correções

- Corrigida a indisponibilidade da integração com o CPA quando um cliente compatível tinha um arquivo de configuração válido, mas nenhum executável detectado. Agora é possível editar modelos e configurações do CPA sempre que a configuração existir, cobrindo de forma consistente WorkBuddy, Pi e todos os demais clientes compatíveis. As ações de iniciar e reiniciar continuam desativadas até que o cliente seja detectado.

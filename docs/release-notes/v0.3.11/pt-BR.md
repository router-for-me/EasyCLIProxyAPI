## Melhorias

- A entrada de contato na barra lateral agora convida usuários de chinês tradicional, japonês e inglês a entrar no [servidor do Discord](https://discord.gg/PxvX4D9kgs). A entrada em chinês simplificado continua abrindo o grupo do QQ existente.

## Correções

- Corrigida a detecção do WorkBuddy / WorkBuddy AI no macOS localizando o executável indicado no `Info.plist` do pacote do aplicativo. A detecção continua usando o caminho anterior quando essa informação está ausente ou inválida.
- Corrigido o problema em que alterações subsequentes na configuração do núcleo às vezes não chegavam a um núcleo em execução após salvamentos repetidos. Configurações como estatísticas de uso e API Keys de clientes agora entram em vigor ao salvar.
- Corrigido o problema em que credenciais OAuth existentes não eram restauradas do backup de atualização do macOS quando o novo pacote do aplicativo já continha um diretório OAuth vazio.

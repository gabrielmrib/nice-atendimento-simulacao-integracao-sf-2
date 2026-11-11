# Atendimento com a Salesforce como roteador de mensagens (sem atendente Salesforce)

| | |
|---|---|
| **Status** | Prova de conceito funcionando na sandbox `dev0`, canal Web (MIAW) |
| **Data** | 11/11/2026 |
| **Não validado** | Canal WhatsApp (os dois canais da sandbox estão inativos) e exibição da resposta na tela do cliente (só foi confirmado o registro na conversa pela API) |

## 1. Resumo

O simulador (que representa Betta + NICE) consegue conduzir uma conversa com um cliente de um canal de Messaging da Salesforce **sem nenhum atendente licenciado na Salesforce**:

- a Salesforce avisa quando uma conversa abre (Omni-Channel Flow → Platform Event → Pub/Sub API);
- o simulador lê as mensagens do cliente consultando a Connect API;
- o atendente responde e o simulador envia o texto pela ação `sendConversationMessages`.

Funciona, mas usa peças da Salesforce **fora do propósito para o qual foram desenhadas**. Os riscos estão na seção 6 e devem ser avaliados antes de qualquer uso em produção.

## 2. Fluxo

```
Cliente ──mensagem──► Salesforce Messaging (MessagingSession fica em "Waiting")
                          │
        (1) abertura      │ Omni-Channel Flow: publica NICE_Conversation_Event__e
                          │                    e faz Route Work p/ fila External Routing
                          ▼
                    Pub/Sub API (gRPC) ──────────────► Simulador EC2 ──WebSocket──► Tela NICE
                                                          │  ▲
        (2) mensagens seguintes do cliente                │  │
            GET /connect/conversation/{id}/entries ◄──────┘  │  (polling a cada 2s)
                                                             │
        (3) resposta do atendente                            │
            POST /actions/standard/sendConversationMessages ◄┘
                          │
                          ▼
                     Salesforce entrega ao cliente
```

| Passo | Quem inicia | Mecanismo | Tempo real? |
|---|---|---|---|
| 1. Abertura | Salesforce | Platform Event entregue por Pub/Sub API | Sim (push) |
| 2. Mensagens do cliente | Simulador | Polling REST na Connect API | Não (até 2s de atraso) |
| 3. Resposta do atendente | Simulador | Action API + conferência em `ConvMessageSendRequest` | Assíncrono (1–6s para confirmar) |
| 4. Aceitar / Encerrar | Simulador | Apenas estado local | — |
| 5. Encerramento pelo cliente | Simulador | SOQL em `MessagingSession` a cada 10s | Não |

## 3. O que foi necessário criar

### 3.1 Na Salesforce

| Item | Para que serve | Quem criou |
|---|---|---|
| **External Client App** com OAuth 2.0 Client Credentials | Autenticação do simulador (REST e Pub/Sub) com um usuário "Run As" | Time |
| **Platform Event `NICE_Conversation_Event__e`** (`Action__c`, `SessionId__c`, `ConversationId__c`, `Message__c`, `Payload__c`) | Avisar o simulador da abertura da conversa | Time |
| **Omni-Channel Flow `Atendimento_test_flow`** | Lê a sessão, publica o evento `OPEN_CONVERSATION` e faz Route Work | Time |
| **Fila `Fila External Betta`** + Routing Config `Config_Roteamento_Externo` (External Routing) | "Estaciona" a sessão em `Waiting` sem a Salesforce tentar entregá-la a um atendente interno | Time |
| **External Service `TransbordoBettaNICE`** (HTTP Callout) | Segundo aviso de abertura, por webhook. **Redundante** (ver seção 4) | Time |
| **Canal de Messaging `Example`** (Web) apontando para o Flow | Canal de teste | Time |
| **Messaging Component `NICE_Agent_Reply`** (tipo Notification, parâmetro de texto `texto`, layout `{!$Parameters.texto}`) | Permite enviar texto livre pela `sendConversationMessages` | Criado via Metadata API; **ativado manualmente** no Setup (nasce em rascunho) |

Permissões do usuário "Run As": leitura no Platform Event, leitura em `MessagingSession`, acesso à Connect API de conversas e execução da ação `sendConversationMessages`.

### 3.2 No simulador (`server.js`)

| Função | O que faz |
|---|---|
| `startPubSub` | Conecta em `api.pubsub.salesforce.com:7443` e assina `/event/NICE_Conversation_Event__e`; reconecta com backoff |
| `processCustomerEvent` | Trata `OPEN_CONVERSATION` / `SEND_MESSAGE` / `CLOSE_CONVERSATION` vindos do Pub/Sub ou do webhook; ignora aberturas duplicadas |
| `loadSessionRuntime` | Busca `Conversation.ConversationIdentifier` e `MessagingEndUserId` da sessão |
| `pollLoop` / `pollSessionMessages` | Lê as mensagens novas do cliente (`sender.role = EndUser`) |
| `syncEndedSessions` | Fecha o card quando a sessão foi encerrada na Salesforce |
| `sendTextToCustomer` | Chama `sendConversationMessages` e confere o resultado em `ConvMessageSendRequest` |

Payload de envio que funcionou:

```json
{ "inputs": [{
    "messageDefinitionName": "NICE_Agent_Reply",
    "messagingDefinitionInputParameters": [{ "name": "texto", "textValue": "resposta do atendente" }],
    "requestType": "SendNotificationMessages",
    "isEnforceMessagingChannelConsent": false,
    "allowedSessionStatus": "Any",
    "messagingEndUserIds": ["0PA..."]
}]}
```

### 3.3 O que **não** funciona (testado)

| Tentativa | Resultado |
|---|---|
| `PATCH MessagingSession.Status` | Campo não gravável (`INVALID_FIELD_FOR_INSERT_UPDATE`). Não é permissão. |
| Change Data Capture em `MessagingSession` / `AgentWork` | Tópicos não existem |
| SOQL em `ConversationEntry` | Sempre vazio; as mensagens só aparecem pela Connect API |
| `sendConversationMessages` com `{conversationId, message}` | Entradas inexistentes na ação |
| Enviar com o componente em rascunho | `MessagingComponentNotActive` |
| `sessionLongevityPreference = KeepSessionOpenOrAppend` | Continua criando sessão extra (seção 5) |

## 4. HTTP Callout × Pub/Sub × polling

**O HTTP Callout pode ser removido do Flow.** Foi verificado que o Flow publica o Platform Event a cada abertura e que o simulador o recebe pelo Pub/Sub. O callout é um segundo aviso da mesma abertura. Removê-lo também elimina a necessidade de expor o EC2 na internet (ngrok) para a Salesforce.

**Remover o callout não muda o polling.** São etapas diferentes:

| Etapa | Mecanismo | Consome chamadas de API REST? |
|---|---|---|
| Abertura | Pub/Sub (push) | Não. Consome a cota de **eventos entregues** |
| Mensagens seguintes do cliente | Polling | **Sim** |

O polling existe porque a Salesforce **não publica nenhum evento** quando o cliente manda uma mensagem numa sessão já aberta, e o Flow só roda na abertura. Não foi encontrada forma de receber essas mensagens por push neste modelo.

### Custo do polling

- 1 chamada a cada 2s por sessão aberta = **1.800 chamadas/hora por sessão** (43.200/dia se ficar aberta o dia todo).
- Mais 1 chamada a cada 10s (no total, não por sessão) para detectar encerramento.
- Cada resposta do atendente: 1 chamada de envio + 1 a 6 de conferência.

| Sessões abertas ao mesmo tempo | Chamadas/hora | Chamadas em 8h |
|---|---|---|
| 10 | 18 mil | 144 mil |
| 100 | 180 mil | 1,44 milhão |
| 500 | 900 mil | 7,2 milhões |

Limite medido na sandbox: **5.000.000 chamadas/dia** (o de produção depende do contrato). Com 500 sessões simultâneas o limite estoura em menos de 6 horas, e ele é compartilhado com todas as outras integrações da org. Aumentar o intervalo reduz o consumo na mesma proporção, ao custo de atraso para o atendente.

## 5. O problema das sessões extras

**Cada resposta do atendente cria um registro novo em `MessagingSession`.**

| | Sessão original | Sessão extra (uma por resposta) |
|---|---|---|
| `Origin` | `InboundInitiated` | `TriggeredOutbound` |
| `Status` | `Waiting` (nunca muda) | `Ended` (nasce encerrada) |
| Dono | Fila External Betta | Usuário de integração |

**Causa:** a `sendConversationMessages` é uma ação de **notificação**, feita para a empresa iniciar um contato. Cada chamada abre uma sessão própria, entrega e encerra. A mensagem chega na mesma conversa do cliente, mas o registro é separado. Cada envio também gera um `ConvMessageSendRequest`.

**Impactos:**
- Uma conversa com 20 respostas gera 21 sessões e 20 requests: crescimento de armazenamento proporcional ao número de mensagens, não de atendimentos.
- Relatórios e dashboards de Messaging (volume, duração, tempo de espera) ficam distorcidos.
- Qualquer automação em `MessagingSession` (triggers, flows, regras) dispara a cada resposta.
- O histórico do cliente fica fragmentado em dezenas de sessões.
- Se o licenciamento ou a cobrança do canal considerar sessões ou notificações, o custo sobe por mensagem. **Não verificado; confirmar com a Salesforce.**

**O que foi tentado:** `KeepSessionOpenOrAppend` não evitou a criação.

**Hipótese não testada:** com a sessão original em `Active`, a opção de anexar pode funcionar. Só um atendente licenciado ou um bot/agente de IA deixa a sessão `Active`. Um bot responderia ao cliente por conta própria, competindo com o atendente NICE, e um agente Agentforce consome créditos.

**Mitigações se o modelo for mantido:** filtrar `Origin != TriggeredOutbound` nos relatórios; rotina de limpeza das sessões extras; revisar automações em `MessagingSession` para ignorá-las.

## 6. Perigos de levar para produção

### 6.1 Uso fora do desenho da plataforma
- A ação de notificação está sendo usada como canal de chat. É um uso não previsto; **mudanças da Salesforce podem quebrá-lo sem aviso**, e o suporte pode não cobrir.
- Recomenda-se validar o modelo com o time de conta da Salesforce (suporte e licenciamento) antes de investir.

### 6.2 WhatsApp (o objetivo real) ainda não foi testado
- Todos os testes foram no canal Web.
- No WhatsApp, a Meta só aceita texto livre **dentro da janela de 24h** após a última mensagem do cliente. Fora dela é obrigatório template aprovado, e o componente `NICE_Agent_Reply` não tem template.
- Não se sabe se uma notificação de texto livre é aceita no canal WhatsApp da Salesforce, nem como é tarifada.

### 6.3 A sessão nunca sai de `Waiting`
- Para a Salesforce o cliente está eternamente "na fila": tempo de espera, SLA e métricas do Omni-Channel ficam sem sentido.
- O cliente pode ver indicações de espera (posição na fila, "aguardando atendente") enquanto já está sendo atendido.
- Timeouts de inatividade do canal podem encerrar a conversa no meio do atendimento.
- A resposta entra na conversa como remetente `System`, não como um atendente com nome.
- Não há indicador de digitação nem confirmação de leitura.

### 6.4 O atendente não controla a sessão
- **Não é possível encerrar a sessão pela API.** Ela só termina quando o cliente fecha ou por timeout.
- Não há transferência, nem devolução para bot ou fila.

### 6.5 Entrega e ordem das mensagens
- O envio é assíncrono; a ordem entre respostas rápidas em sequência não é garantida.
- A ação tem limite de 200 invocações em andamento por org; acima disso, enfileira.
- `isEnforceMessagingChannelConsent = false` **ignora a verificação de consentimento** do cliente. Em produção isso precisa ser revisto (LGPD e políticas da Meta).
- Só texto: anexos, imagens e áudios do cliente não são tratados.

### 6.6 Limites de API e latência
- Ver seção 4: o polling escala mal e disputa o limite diário da org.
- Atraso de até 2s para o atendente ver cada mensagem.

### 6.7 Perda de eventos de abertura
- O simulador guarda o último `replayId` **só em memória**. Se o processo reiniciar, ele volta a assinar a partir do evento mais recente e **perde as aberturas ocorridas enquanto estava fora**. Em produção o `replayId` precisa ser persistido.
- O estado das conversas também fica só em memória e em uma única instância.

### 6.8 Segurança do simulador
- Os endpoints (`/api/agent/reply`, `/api/customer/events` etc.) **não têm autenticação**. Qualquer pessoa com a URL do ngrok consegue enviar mensagens a clientes em nome da empresa.
- CORS aberto, WebSocket sem autenticação, e os logs do servidor (com dados de clientes) são transmitidos a qualquer navegador conectado.
- O usuário de integração usado nos testes tem permissão para alterar metadados; em produção ele deve ter o mínimo necessário.

### 6.9 Dados pessoais
- Nome, identificador e conteúdo das conversas trafegam entre Salesforce, Betta e NICE. É preciso base legal, minimização e retenção definidas.

## 7. Como funciona o Pub/Sub API da Salesforce

O Pub/Sub API é a interface de eventos da Salesforce baseada em **gRPC** (HTTP/2). No lugar de a Salesforce chamar um endereço nosso (webhook), **o nosso servidor abre uma conexão de saída** e os eventos descem por ela.

| Conceito | Explicação |
|---|---|
| **Endpoint** | `api.pubsub.salesforce.com:7443`. Só precisa de saída liberada no firewall; nada exposto na internet. |
| **Autenticação** | A cada chamada vão o access token OAuth, a URL da instância e o ID da org. O simulador obtém o token por Client Credentials. |
| **Tópico** | O canal assinado. Platform Events customizados: `/event/Nome__e`. Change Data Capture: `/data/ObjetoChangeEvent`. |
| **Publicação** | Quem publica aqui é o Flow, com um "Create Records" no Platform Event. |
| **Formato** | Os eventos vêm em **Avro** (binário). O cliente busca o schema pelo ID e decodifica; a biblioteca `salesforce-pubsub-api-client` faz isso. |
| **Controle de fluxo** | O assinante pede N eventos (`numRequested`); a Salesforce entrega até N e aguarda novo pedido. A biblioteca renova o pedido sozinha. |
| **Replay ID** | Cada evento tem um número de sequência. Dá para assinar a partir do mais recente, do mais antigo retido, ou de um `replayId` específico. |
| **Retenção** | Eventos ficam disponíveis por **72 horas**. Guardando o último `replayId`, o assinante recupera o que perdeu numa queda. |
| **Keepalive** | Sem eventos, a Salesforce manda um sinal a cada ~270s; se o stream cair, o cliente precisa reassinar (o simulador faz com backoff). |
| **Limites** | Conta na cota de eventos entregues. Medido na sandbox: 85.000 entregues/dia e 2.250.000/mês. Não consome o limite de chamadas REST. |

**No nosso fluxo:**
1. O cliente abre o chat e o Omni-Channel Flow executa.
2. O Flow cria um `NICE_Conversation_Event__e` com `Action__c = OPEN_CONVERSATION`, o ID da sessão e um JSON com os dados do contato.
3. A Salesforce coloca o evento no barramento e o entrega pelo stream gRPC já aberto.
4. O simulador decodifica, converte para o formato interno e mostra o card na fila da NICE.

**Limitação importante:** o Pub/Sub só entrega o que alguém publica. A Salesforce não publica evento para cada mensagem do cliente, e por isso o passo 2 do fluxo depende de polling.

## 8. Próximos passos sugeridos

1. Confirmar visualmente que a resposta do atendente aparece na tela do cliente.
2. Ativar um canal WhatsApp na sandbox e repetir o teste de envio (dentro e fora da janela de 24h).
3. Levar o modelo ao time de conta da Salesforce: suporte, licenciamento e tarifação das notificações.
4. Decidir sobre o experimento do bot para deixar a sessão `Active` (seção 5).
5. Comparar com a arquitetura alternativa em [especificacao-transbordo-whatsapp-nice.md](especificacao-transbordo-whatsapp-nice.md), em que a Betta conversa direto com a Meta e a Salesforce só decide o roteamento. Aquele documento é anterior a esta prova de conceito: a afirmação de que a `sendConversationMessages` não serve para texto livre foi superada pelo uso do componente parametrizado.

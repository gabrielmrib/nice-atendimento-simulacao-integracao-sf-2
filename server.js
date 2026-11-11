/**
 * SERVIDOR UNIFICADO - GATEWAY BETTA & NICE CONSOLE (Node.js / EC2)
 *
 * Responsabilidades:
 *  1. Inbound  (Salesforce ➔ EC2): recebe eventos de conversa do MIAW por DOIS canais
 *       a) Pub/Sub API (gRPC) assinando o Platform Event NICE_Conversation_Event__e  ← canal principal
 *       b) Webhook HTTP POST /api/customer/events (HTTP Callout do Omni-Channel Flow) ← fallback
 *     Os dois canais caem no mesmo handler (processCustomerEvent) e são idempotentes.
 *  2. Leitura das mensagens do cliente: polling da Connect API /connect/conversation/{id}/entries
 *     (o Omni-Channel Flow só roda na abertura; as mensagens seguintes são lidas por aqui).
 *  3. Outbound (EC2 ➔ Salesforce ➔ cliente): a resposta do atendente NICE é enviada pela ação
 *     sendConversationMessages usando o Messaging Component NICE_Agent_Reply (parâmetro "texto").
 *     A Salesforce funciona como roteador: nenhum atendente Salesforce participa da sessão, que
 *     permanece "Waiting" na fila de External Routing (o campo Status não é gravável via API).
 *  4. Tempo real (EC2 ➔ Front): WebSocket com estado das sessões + logs do servidor (DEBUG_LOG, F12).
 */

require('dotenv').config({ quiet: true }); // carrega SF_DOMAIN / SF_CLIENT_ID / SF_CLIENT_SECRET do .env

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const path = require('path');
const PubSubApiClient = require('salesforce-pubsub-api-client').default;

const app = express();
app.use(cors());
app.use(express.json());

// Servir os arquivos estáticos da pasta public/ (Agent Desktop simulado)
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

/**
 * Configuração da Org Salesforce.
 * - domain: My Domain da org (login e REST). Barra final removida para não gerar "//services".
 * - clientId/clientSecret: External Client App com fluxo OAuth 2.0 Client Credentials habilitado
 *   (o "Run As" user precisa de leitura no Platform Event e edição em MessagingSession).
 * - pubsubTopic: canal Pub/Sub. Platform Events customizados usam o prefixo /event/.
 */
const SF_CONFIG = {
    domain: (process.env.SF_DOMAIN || 'https://seu-dominio.my.salesforce.com').replace(/\/+$/, ''),
    clientId: process.env.SF_CLIENT_ID || 'SEU_CLIENT_ID',
    clientSecret: process.env.SF_CLIENT_SECRET || 'SEU_CLIENT_SECRET',
    apiVersion: 'v61.0',
    pubsubTopic: process.env.SF_PUBSUB_TOPIC || '/event/NICE_Conversation_Event__e',
    pubsubEnabled: process.env.SF_PUBSUB_ENABLED !== 'false',
    // Messaging Component (tipo Notification, parâmetro de texto "texto") usado para responder ao cliente
    replyComponent: process.env.SF_REPLY_COMPONENT || 'NICE_Agent_Reply',
    // Intervalo do polling das mensagens do cliente (Connect API conversation entries)
    pollIntervalMs: Number(process.env.SF_POLL_INTERVAL_MS) || 2000
};

// Armazenamento em memória das sessões (chave = MessagingSession Id "0Mw...")
const activeSessions = new Map();

// Estado da assinatura Pub/Sub, exibido no header do front
let pubsubStatus = { state: 'DISABLED', topic: SF_CONFIG.pubsubTopic, detail: '' };

/** Envia um objeto JSON para todas as consoles conectadas via WebSocket. */
function broadcast(data) {
    const payload = JSON.stringify(data);
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) client.send(payload);
    });
}

// --- INTERCEPTADOR DE LOGS (envia logs da EC2 para o console do navegador, F12) ---
const originalLog = console.log;
const originalError = console.error;

/** Serializa os argumentos de console.* (objetos e Errors) em uma única string. */
function formatLogArgs(args) {
    return Array.from(args).map(arg => {
        if (arg instanceof Error) return arg.stack || arg.message;
        return typeof arg === 'object' ? JSON.stringify(arg) : arg;
    }).join(' ');
}

console.log = function () {
    originalLog.apply(console, arguments);
    broadcast({ type: 'DEBUG_LOG', level: 'info', text: formatLogArgs(arguments) });
};

console.error = function () {
    originalError.apply(console, arguments);
    broadcast({ type: 'DEBUG_LOG', level: 'error', text: formatLogArgs(arguments) });
};

// --- AUTENTICAÇÃO OAUTH 2.0 (CLIENT CREDENTIALS) ---

/**
 * Cache do token. O fluxo client_credentials não devolve expires_in, então reaproveitamos
 * o token por um tempo curto e, em caso de 401, forçamos a renovação (ver sfRequest).
 */
let tokenCache = { accessToken: null, instanceUrl: null, fetchedAt: 0 };
const TOKEN_TTL_MS = 15 * 60 * 1000;

/**
 * Obtém um access token via POST /services/oauth2/token (grant_type=client_credentials).
 * @param {boolean} [forceRefresh=false] ignora o cache
 * @returns {Promise<{accessToken: string, instanceUrl: string}>}
 */
async function getSalesforceToken(forceRefresh = false) {
    if (!forceRefresh && tokenCache.accessToken && Date.now() - tokenCache.fetchedAt < TOKEN_TTL_MS) {
        return tokenCache;
    }

    const res = await fetch(`${SF_CONFIG.domain}/services/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: SF_CONFIG.clientId,
            client_secret: SF_CONFIG.clientSecret
        }).toString()
    });

    if (!res.ok) {
        const text = await res.text();
        throw new SalesforceError(`Falha OAuth Salesforce (HTTP ${res.status})`, res.status, safeJson(text));
    }

    const data = await res.json();
    tokenCache = {
        accessToken: data.access_token,
        instanceUrl: (data.instance_url || SF_CONFIG.domain).replace(/\/+$/, ''),
        fetchedAt: Date.now()
    };
    return tokenCache;
}

/** Erro com o status HTTP e o corpo devolvido pelo Salesforce, para repassar ao front. */
class SalesforceError extends Error {
    constructor(message, status, details) {
        super(message);
        this.status = status;
        this.details = details;
    }
}

function safeJson(text) {
    try { return JSON.parse(text); } catch { return text; }
}

/**
 * Chamada REST autenticada ao Salesforce. Renova o token e tenta de novo uma vez em caso de 401.
 * Lança SalesforceError com o corpo de erro do Salesforce (ex.: [{errorCode, message}]) se !ok.
 * @param {string} method  GET | POST | PATCH ...
 * @param {string} apiPath caminho a partir de /services/data/vXX.X (ex.: "/sobjects/MessagingSession/0Mw...")
 * @param {object} [body]
 */
async function sfRequest(method, apiPath, body) {
    for (let attempt = 0; attempt < 2; attempt++) {
        const { accessToken, instanceUrl } = await getSalesforceToken(attempt > 0);
        const res = await fetch(`${instanceUrl}/services/data/${SF_CONFIG.apiVersion}${apiPath}`, {
            method,
            headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
            body: body ? JSON.stringify(body) : undefined
        });

        if (res.status === 401 && attempt === 0) continue; // token expirado/revogado → renova

        const text = await res.text(); // PATCH bem-sucedido retorna 204 sem corpo
        const data = text ? safeJson(text) : null;
        if (!res.ok) {
            throw new SalesforceError(`Salesforce ${method} ${apiPath} falhou (HTTP ${res.status})`, res.status, data);
        }
        return data;
    }
}

/**
 * Dados da sessão guardados só no backend (não vão para o front):
 *   conversationIdentifier → UUID da Conversation, chave da Connect API de entries
 *   messagingEndUserId     → destinatário do sendConversationMessages
 *   seen                   → identifiers de entries já processadas (deduplicação do polling)
 *   pollFailed             → evita repetir o mesmo erro de polling no log a cada ciclo
 */
const sessionRuntime = new Map();
const SF_ID_REGEX = /^[a-zA-Z0-9]{15,18}$/;

/**
 * Busca na Salesforce os identificadores necessários para ler e responder a conversa.
 * MessagingSession.Conversation.ConversationIdentifier é o UUID usado pela Connect API.
 */
async function loadSessionRuntime(sessionId) {
    let rt = sessionRuntime.get(sessionId);
    if (rt && rt.conversationIdentifier) return rt;
    if (!SF_ID_REGEX.test(sessionId)) throw new Error(`Id de MessagingSession inválido: ${sessionId}`);

    const soql = `SELECT Id, Status, MessagingEndUserId, Conversation.ConversationIdentifier FROM MessagingSession WHERE Id = '${sessionId}'`;
    const data = await sfRequest('GET', `/query?q=${encodeURIComponent(soql)}`);
    const rec = data?.records?.[0];
    if (!rec) throw new SalesforceError(`MessagingSession ${sessionId} não encontrada`, 404, data);

    rt = {
        conversationIdentifier: rec.Conversation?.ConversationIdentifier,
        messagingEndUserId: rec.MessagingEndUserId,
        seen: rt?.seen || new Set(),
        pollFailed: false
    };
    sessionRuntime.set(sessionId, rt);
    console.log(`[Salesforce] Sessão ${sessionId}: conversa ${rt.conversationIdentifier}, end user ${rt.messagingEndUserId}`);
    return rt;
}

/**
 * Lê as mensagens novas do cliente em uma sessão.
 * Connect API: GET /connect/conversation/{conversationIdentifier}/entries
 * Só entram entries com sender.role = "EndUser"; as respostas do atendente já são
 * adicionadas ao histórico no momento do envio.
 */
async function pollSessionMessages(session) {
    const rt = await loadSessionRuntime(session.identifier);
    if (!rt.conversationIdentifier) return;

    const data = await sfRequest('GET', `/connect/conversation/${rt.conversationIdentifier}/entries?queryDirection=FromStart&recordLimit=200`);
    const entries = Array.isArray(data?.conversationEntries) ? data.conversationEntries : [];
    const novas = [];
    entries
        .sort((x, y) => (x.serverReceivedTimestamp || 0) - (y.serverReceivedTimestamp || 0))
        .forEach(e => {
            if (!e || !e.identifier || rt.seen.has(e.identifier)) return;
            rt.seen.add(e.identifier);
            if (e.sender?.role === 'EndUser' && e.messageText) novas.push(e.messageText);
        });

    if (novas.length) {
        novas.forEach(t => session.history.push({ sender: 'user', text: t }));
        console.log(`[Inbound poll] ${novas.length} mensagem(ns) do cliente na sessão ${session.identifier}`);
        broadcast({ type: 'NEW_USER_MESSAGE', sessionId: session.identifier, messages: novas });
    }
}

/** Detecta sessões encerradas na Salesforce (cliente fechou o chat / timeout) e fecha o card. */
async function syncEndedSessions(sessions) {
    const validas = sessions.filter(s => SF_ID_REGEX.test(s.identifier));
    if (!validas.length) return;

    const soql = `SELECT Id FROM MessagingSession WHERE Status = 'Ended' AND Id IN ('${validas.map(s => s.identifier).join("','")}')`;
    const data = await sfRequest('GET', `/query?q=${encodeURIComponent(soql)}`);
    (data?.records || []).forEach(rec => {
        // o Flow pode enviar o Id com 15 ou 18 caracteres; compara pelos 15 primeiros
        const session = validas.find(s => rec.Id.slice(0, 15) === s.identifier.slice(0, 15));
        if (session && session.status !== 'CLOSED') {
            session.status = 'CLOSED';
            sessionRuntime.delete(session.identifier);
            console.log(`[Salesforce] Sessão ${session.identifier} foi encerrada na Salesforce.`);
            broadcast({ type: 'CONVERSATION_CLOSED', sessionId: session.identifier });
        }
    });
}

let pollTick = 0;
let pollRunning = false;

/** Loop de polling: mensagens a cada ciclo, verificação de encerramento a cada 5 ciclos. */
async function pollLoop() {
    if (pollRunning) return; // evita sobreposição se a Salesforce demorar a responder
    pollRunning = true;
    try {
        const abertas = Array.from(activeSessions.values()).filter(s => s.status !== 'CLOSED');
        for (const session of abertas) {
            try {
                await pollSessionMessages(session);
                const rt = sessionRuntime.get(session.identifier);
                if (rt) rt.pollFailed = false;
            } catch (err) {
                const rt = sessionRuntime.get(session.identifier) || {};
                if (!rt.pollFailed) console.error(`[Inbound poll] Falha na sessão ${session.identifier}:`, err.message, JSON.stringify(err.details || ''));
                rt.pollFailed = true;
                if (!sessionRuntime.has(session.identifier)) sessionRuntime.set(session.identifier, { seen: new Set(), ...rt });
            }
        }
        if (++pollTick % 5 === 0 && abertas.length) {
            await syncEndedSessions(abertas).catch(err => console.error('[Inbound poll] Falha ao checar encerramento:', err.message));
        }
    } finally {
        pollRunning = false;
    }
}

/**
 * Envia texto livre ao cliente pela Salesforce, sem atendente Salesforce.
 * Action API: POST /actions/standard/sendConversationMessages
 *   messageDefinitionName              → Messaging Component (Notification) com parâmetro "texto"
 *   messagingDefinitionInputParameters → [{ name: "texto", textValue }]
 *   allowedSessionStatus: "Any"        → envia mesmo com sessão aberta (Waiting/Active)
 * A ação é assíncrona: o resultado real fica em ConvMessageSendRequest, consultado em seguida.
 */
async function sendTextToCustomer(sessionId, text) {
    const rt = await loadSessionRuntime(sessionId);
    if (!rt.messagingEndUserId) throw new Error(`Sessão ${sessionId} sem MessagingEndUser.`);

    const result = await sfRequest('POST', '/actions/standard/sendConversationMessages', {
        inputs: [{
            messageDefinitionName: SF_CONFIG.replyComponent,
            messagingDefinitionInputParameters: [{ name: 'texto', textValue: text }],
            requestType: 'SendNotificationMessages',
            isEnforceMessagingChannelConsent: false,
            allowedSessionStatus: 'Any',
            messagingEndUserIds: [rt.messagingEndUserId]
        }]
    });
    const item = Array.isArray(result) ? result[0] : null;
    if (!item || item.isSuccess === false) {
        throw new SalesforceError('sendConversationMessages retornou isSuccess=false', 200, item?.errors || result);
    }

    // Confere o processamento assíncrono (até ~6s)
    const requestId = item.outputValues?.requestId;
    for (let i = 0; requestId && i < 6; i++) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        const req = await sfRequest('GET', `/sobjects/ConvMessageSendRequest/${requestId}?fields=RequestStatus,SuccessMessageCount,FailedMessageCount,FailedMessageErrorReasons`);
        if (req.FailedMessageCount > 0) {
            throw new SalesforceError(`Salesforce não entregou a mensagem: ${(req.FailedMessageErrorReasons || []).join(', ')}`, 200, req);
        }
        if (req.SuccessMessageCount > 0 || req.RequestStatus === 'Completed') return req;
    }
    return null; // ainda em processamento; tratado como enviado
}

/** Converte um erro em resposta JSON detalhada para o front. */
function sendError(res, err, fallbackMessage) {
    const status = err instanceof SalesforceError ? 502 : 500; // 502 = falha no upstream Salesforce
    res.status(status).json({
        success: false,
        error: err.message || fallbackMessage,
        salesforceStatus: err.status,
        salesforceDetails: err.details
    });
}

// --- WEBSOCKET: estado inicial para cada console que conecta ---
wss.on('connection', (ws) => {
    originalLog('[WebSocket] Consola NICE CXone conectada.');
    ws.send(JSON.stringify({ type: 'INIT_STATE', sessions: Array.from(activeSessions.values()) }));
    ws.send(JSON.stringify({ type: 'PUBSUB_STATUS', ...pubsubStatus }));
});

// --- 1. PROCESSAMENTO DE EVENTOS DE ENTRADA (compartilhado por Webhook e Pub/Sub) ---

/** Extrai texto de uma mensagem que pode vir como string, {text}, ou formato de bot [{default:{text}}]. */
function extractText(message) {
    if (message == null) return '';
    if (typeof message === 'string') return message;
    if (Array.isArray(message)) return message.map(extractText).filter(Boolean).join('\n');
    if (typeof message === 'object') return message.text || message.default?.text || '';
    return String(message);
}

/**
 * Processa um evento de conversa no formato do webhook:
 *   { action, identifier, conversationId?, requestId?, message?, parameters?: { contact, extraInfo, initialMessage, messages } }
 * @param {object} body
 * @param {'webhook'|'pubsub'} source
 * @returns {{ status: number, body: object }}
 */
function processCustomerEvent(body, source) {
    if (!body || typeof body !== 'object') {
        return { status: 400, body: { error: 'Payload ausente ou não é JSON.' } };
    }

    const action = body.action;
    const sessionId = body.identifier;
    const params = (body.parameters && typeof body.parameters === 'object') ? body.parameters : {};
    const contact = (params.contact && typeof params.contact === 'object') ? params.contact : {};
    const extraInfo = (params.extraInfo && typeof params.extraInfo === 'object') ? params.extraInfo : {};
    const ack = { requestId: body.requestId || `req_${Date.now()}`, message: 'OK' };

    if (!sessionId) {
        return { status: 400, body: { error: 'identifier (MessagingSession Id) obrigatório' } };
    }

    // Abertura de conversa (Omni-Channel Flow, após Route Work para a fila com External Routing)
    if (action === 'OPEN_CONVERSATION') {
        const existing = activeSessions.get(sessionId);
        if (existing && existing.status !== 'CLOSED') {
            // Idempotência: o mesmo OPEN pode chegar pelo webhook E pelo Pub/Sub
            console.log(`[Inbound ${source}] OPEN_CONVERSATION duplicado ignorado para ${sessionId}`);
            return { status: 200, body: ack };
        }

        const history = [];
        if (Array.isArray(contact.history)) {
            contact.history.forEach(item => {
                if (!item || (item.sender !== 'user' && item.sender !== 'bot')) return;
                const txt = extractText(item.message);
                if (txt) history.push({ sender: item.sender, text: txt });
            });
        }
        // Fallback de mensagem inicial se o histórico vier vazio
        const initial = extractText(params.initialMessage || body.message);
        if (history.length === 0 && initial) history.push({ sender: 'user', text: initial });

        const sessionData = {
            identifier: sessionId,
            conversationId: body.conversationId || sessionId,
            status: 'QUEUED',
            source,
            contact: {
                name: contact.name || 'Cliente Web',
                phone: contact.phone || 'Não informado',
                cpf: contact.cpf || extraInfo.CPF || 'Não informado',
                email: contact.email || 'Não informado',
                canalOperacao: extraInfo.CanalOperacao || 'Porto_Cartoes'
            },
            history
        };

        activeSessions.set(sessionId, sessionData);
        broadcast({ type: 'NEW_CONVERSATION', session: sessionData });
        // Resolve conversa/end user na Salesforce; o polling passa a trazer as mensagens do cliente
        loadSessionRuntime(sessionId).catch(err => console.error(`[Salesforce] Falha ao carregar sessão ${sessionId}:`, err.message));
        return { status: 200, body: ack };
    }

    // Mensagens subsequentes do cliente
    if (action === 'SEND_MESSAGE') {
        const session = activeSessions.get(sessionId);
        if (!session) {
            console.error(`[Inbound ${source}] SEND_MESSAGE para sessão desconhecida: ${sessionId}`);
            return { status: 404, body: { error: `Sessão ${sessionId} não encontrada no gateway.` } };
        }
        const raw = Array.isArray(params.messages) ? params.messages : [body.message];
        const texts = raw.map(extractText).filter(Boolean);
        texts.forEach(t => session.history.push({ sender: 'user', text: t }));
        if (texts.length) broadcast({ type: 'NEW_USER_MESSAGE', sessionId, messages: texts });
        return { status: 200, body: ack };
    }

    // Encerramento pelo cliente / Salesforce
    if (action === 'CLOSE_CONVERSATION') {
        const session = activeSessions.get(sessionId);
        if (session) {
            session.status = 'CLOSED';
            broadcast({ type: 'CONVERSATION_CLOSED', sessionId });
        }
        return { status: 200, body: ack };
    }

    console.log(`[Inbound ${source}] Ação não mapeada ignorada: ${action}`);
    return { status: 200, body: { message: 'Ação não mapeada ignorada.' } };
}

// Webhook HTTP (fallback / HTTP Callout do Omni-Channel Flow)
app.post('/api/customer/events', (req, res) => {
    try {
        console.log('[Inbound webhook] Evento recebido:', JSON.stringify(req.body));
        const result = processCustomerEvent(req.body, 'webhook');
        res.status(result.status).json(result.body);
    } catch (err) {
        console.error('[Inbound webhook] Erro no processamento:', err);
        res.status(500).json({ error: err.message });
    }
});

// --- 1b. INBOUND VIA PUB/SUB API (gRPC) ---

/**
 * Campos Avro opcionais podem chegar como { string: "valor" } dependendo do decoder; normaliza.
 */
function unwrapAvro(v) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
        const keys = Object.keys(v);
        if (keys.length === 1 && ['string', 'long', 'int', 'boolean', 'double'].includes(keys[0])) return v[keys[0]];
    }
    return v;
}

/**
 * Converte o payload do Platform Event NICE_Conversation_Event__e para o formato do webhook.
 * Campos esperados no evento:
 *   Action__c         OPEN_CONVERSATION | SEND_MESSAGE | CLOSE_CONVERSATION
 *   SessionId__c      Id da MessagingSession (0Mw...)
 *   ConversationId__c Id da Conversation (0dw...) - opcional
 *   Message__c        texto da mensagem do cliente - opcional
 *   Payload__c        JSON com { contact, extraInfo, ... } - opcional
 */
function platformEventToBody(payload) {
    const p = {};
    Object.keys(payload || {}).forEach(k => { p[k] = unwrapAvro(payload[k]); });

    let parameters = {};
    if (p.Payload__c) {
        const parsed = safeJson(p.Payload__c);
        if (parsed && typeof parsed === 'object') parameters = parsed;
        else console.error('[Inbound pubsub] Payload__c não é JSON válido:', p.Payload__c);
    }

    return {
        action: p.Action__c,
        identifier: p.SessionId__c,
        conversationId: p.ConversationId__c || undefined,
        message: p.Message__c || undefined,
        parameters
    };
}

let pubsubClient = null;
let lastReplayId = null;     // permite retomar sem perder eventos após queda do stream
let reconnectDelayMs = 2000;

function setPubsubStatus(state, detail = '') {
    pubsubStatus = { state, topic: SF_CONFIG.pubsubTopic, detail };
    broadcast({ type: 'PUBSUB_STATUS', ...pubsubStatus });
}

/** Callback do subscribe: trata eventos e o ciclo de vida do stream gRPC. */
function onPubsubCallback(subscription, callbackType, data) {
    switch (callbackType) {
        case 'event': {
            reconnectDelayMs = 2000;
            lastReplayId = data.replayId;
            console.log(`[Inbound pubsub] Evento recebido (replayId ${data.replayId}):`, JSON.stringify(data.payload));
            try {
                const result = processCustomerEvent(platformEventToBody(data.payload), 'pubsub');
                if (result.status >= 400) console.error('[Inbound pubsub] Evento rejeitado:', result.body.error);
            } catch (err) {
                console.error('[Inbound pubsub] Erro ao processar evento:', err);
            }
            break;
        }
        case 'error':
            console.error('[Pub/Sub] Erro no stream:', data?.details || data?.message || data);
            setPubsubStatus('ERROR', data?.details || data?.message || 'erro no stream');
            break;
        case 'end':
            console.error('[Pub/Sub] Stream encerrado. Reconectando...');
            scheduleResubscribe();
            break;
        case 'grpcKeepalive':
            if (data?.latestReplayId) lastReplayId = data.latestReplayId;
            break;
        default:
            break;
    }
}

function scheduleResubscribe() {
    setPubsubStatus('RECONNECTING', pubsubStatus.detail); // mantém o último erro visível no front
    setTimeout(() => startPubSub().catch(() => {}), reconnectDelayMs);
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, 60000);
}

/**
 * Conecta à Pub/Sub API (api.pubsub.salesforce.com:7443) com client_credentials e assina o tópico.
 * Se houver lastReplayId, retoma a partir dele (dentro da janela de retenção de 72h).
 */
async function startPubSub() {
    if (!SF_CONFIG.pubsubEnabled) {
        setPubsubStatus('DISABLED');
        return;
    }
    try {
        if (pubsubClient) {
            try { pubsubClient.close(); } catch { /* já fechado */ }
        }
        // Logger próprio: suprime debug e passa info/erros pelo interceptador (aparece no F12)
        const logger = { debug: () => {}, info: (...a) => console.log('[Pub/Sub]', ...a), warn: (...a) => console.log('[Pub/Sub]', ...a), error: (...a) => console.error('[Pub/Sub]', ...a) };
        pubsubClient = new PubSubApiClient({
            authType: 'oauth-client-credentials',
            loginUrl: SF_CONFIG.domain,
            clientId: SF_CONFIG.clientId,
            clientSecret: SF_CONFIG.clientSecret
        }, logger);
        await pubsubClient.connect();

        if (lastReplayId != null) {
            await pubsubClient.subscribeFromReplayId(SF_CONFIG.pubsubTopic, onPubsubCallback, null, lastReplayId);
        } else {
            await pubsubClient.subscribe(SF_CONFIG.pubsubTopic, onPubsubCallback);
        }
        setPubsubStatus('CONNECTED');
        console.log(`[Pub/Sub] Assinando ${SF_CONFIG.pubsubTopic}`);
    } catch (err) {
        console.error('[Pub/Sub] Falha ao conectar/assinar:', err.message);
        setPubsubStatus('ERROR', err.message);
        scheduleResubscribe();
    }
}

// --- 2. ENDPOINTS DE SAÍDA (Front-end NICE ➔ Node.js ➔ Salesforce API) ---

/**
 * Aceitar atendimento: apenas estado local (NICE).
 * Não há chamada à Salesforce: MessagingSession.Status não é gravável via API e a sessão
 * permanece "Waiting" na fila de External Routing enquanto o atendente NICE conversa.
 */
app.post('/api/agent/accept', (req, res) => {
    const { sessionId } = req.body || {};
    if (!sessionId) return res.status(400).json({ success: false, error: 'sessionId obrigatório' });
    const session = activeSessions.get(sessionId);
    if (!session) return res.status(404).json({ success: false, error: `Sessão ${sessionId} não encontrada no gateway.` });

    console.log(`[Atendente] Atendimento aceito na NICE: ${sessionId}`);
    session.status = 'ACTIVE';
    broadcast({ type: 'CONVERSATION_ACCEPTED', sessionId });
    res.status(200).json({ success: true });
});

/** Enviar resposta do atendente: NICE ➔ EC2 ➔ Salesforce (sendConversationMessages) ➔ cliente. */
app.post('/api/agent/reply', async (req, res) => {
    const { sessionId, messageText } = req.body || {};
    if (!sessionId || !messageText || !String(messageText).trim()) {
        return res.status(400).json({ success: false, error: 'sessionId e messageText obrigatórios' });
    }

    try {
        console.log(`[Outbound SF] Enviando resposta para sessão: ${sessionId}`);
        const result = await sendTextToCustomer(sessionId, String(messageText));
        console.log('[Outbound SF] Resultado:', JSON.stringify(result));

        const session = activeSessions.get(sessionId);
        if (session) {
            session.history.push({ sender: 'agent', text: messageText });
            broadcast({ type: 'AGENT_REPLIED', sessionId, text: messageText });
        }
        res.status(200).json({ success: true });
    } catch (err) {
        console.error('Erro no envio do atendente:', err.message, JSON.stringify(err.details || ''));
        sendError(res, err, 'Falha ao enviar mensagem');
    }
});

/**
 * Encerrar atendimento: apenas estado local.
 * A Salesforce não permite encerrar a MessagingSession via API (Status/EndTime não graváveis);
 * ela termina quando o cliente fecha o chat ou pelo timeout de inatividade do canal.
 */
app.post('/api/agent/close', (req, res) => {
    const { sessionId } = req.body || {};
    if (!sessionId) return res.status(400).json({ success: false, error: 'sessionId obrigatório' });
    console.log(`[Atendente] Encerrando sessão na NICE: ${sessionId}`);

    const session = activeSessions.get(sessionId);
    if (session) {
        session.status = 'CLOSED';
        broadcast({ type: 'CONVERSATION_CLOSED', sessionId });
    }
    sessionRuntime.delete(sessionId);
    res.status(200).json({ success: true });
});

// JSON malformado (ex.: HTTP Callout com corpo inválido) → resposta JSON em vez da página HTML do Express
app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') {
        console.error(`[HTTP] JSON inválido em ${req.method} ${req.path}:`, err.message);
        return res.status(400).json({ error: 'Corpo da requisição não é um JSON válido.', details: err.message });
    }
    next(err);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    originalLog(`Servidor rodando em: http://localhost:${PORT}`);
    startPubSub();
    setInterval(pollLoop, SF_CONFIG.pollIntervalMs);
});

/**
 * Bot Telegram → Instagram | @julianarickli
 * Automação para postar fotos, vídeos (Reels) e carrosséis no Instagram
 * diretamente do Telegram, com confirmação antes de publicar.
 *
 * Autor: Wire (Segunda-feira)
 */

require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const https = require('https');
const http = require('http');

// ---------------------------------------------------------------------------
// Singleton: garante que apenas uma instância rode por vez
// ---------------------------------------------------------------------------
const LOCK_FILE = path.join(__dirname, 'bot.lock');
if (fs.existsSync(LOCK_FILE)) {
  const pid = fs.readFileSync(LOCK_FILE, 'utf8').trim();
  try { process.kill(parseInt(pid), 0); console.error(`[ERRO] Bot já está rodando (PID ${pid}). Encerrando.`); process.exit(1); }
  catch (e) { fs.unlinkSync(LOCK_FILE); }
}
fs.writeFileSync(LOCK_FILE, String(process.pid));
process.on('exit', () => { try { fs.unlinkSync(LOCK_FILE); } catch(e){} });
process.on('SIGINT', () => process.exit());
process.on('SIGTERM', () => process.exit());

// ---------------------------------------------------------------------------
// Configuração e validação de variáveis de ambiente
// ---------------------------------------------------------------------------

const REQUIRED_ENVS = [
  'TELEGRAM_BOT_TOKEN',
  'META_ACCESS_TOKEN',
  'IG_USER_ID',
  'ALLOWED_CHAT_ID',
];

for (const key of REQUIRED_ENVS) {
  if (!process.env[key]) {
    console.error(`[ERRO FATAL] Variável de ambiente ausente: ${key}`);
    process.exit(1);
  }
}

const TELEGRAM_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const META_TOKEN = (process.env.META_ACCESS_TOKEN || '').trim();
const IG_USER_ID = (process.env.IG_USER_ID || '').trim();
const ALLOWED_CHAT_ID = parseInt(process.env.ALLOWED_CHAT_ID, 10);
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');

// Diretórios
const TMP_DIR = path.join(__dirname, 'tmp');
const LOGS_DIR = path.join(__dirname, 'logs');
const LOG_FILE = path.join(LOGS_DIR, 'posts.json');

// Garante que os diretórios existem
[TMP_DIR, LOGS_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Limites da Meta API
const DAILY_LIMIT = 25;

// ---------------------------------------------------------------------------
// Estado em memória da sessão (por chat)
// ---------------------------------------------------------------------------

/**
 * Estrutura do estado por usuário:
 * {
 *   step: 'idle' | 'waiting_caption' | 'waiting_confirm',
 *   mediaType: 'photo' | 'video' | 'carousel',
 *   mediaFiles: [{ filePath, fileId, type }],  // array para carrossel
 *   caption: string,
 *   scheduledTime: null | Date,
 * }
 */
const sessions = {};

function getSession(chatId) {
  if (!sessions[chatId]) {
    sessions[chatId] = {
      step: 'idle',
      mediaType: null,
      mediaFiles: [],
      caption: '',
      scheduledTime: null,
    };
  }
  return sessions[chatId];
}

function resetSession(chatId) {
  const existing = sessions[chatId];
  if (existing) {
    existing.step = 'idle';
    existing.mediaType = null;
    existing.mediaFiles = [];
    existing.caption = '';
    existing.scheduledTime = null;
  } else {
    sessions[chatId] = {
      step: 'idle',
      mediaType: null,
      mediaFiles: [],
      caption: '',
      scheduledTime: null,
    };
  }
}

// ---------------------------------------------------------------------------
// Posts agendados (em memória — em produção, usar DB)
// ---------------------------------------------------------------------------
const scheduledPosts = [];

// ---------------------------------------------------------------------------
// Log de posts publicados
// ---------------------------------------------------------------------------

function carregarLogs() {
  try {
    if (fs.existsSync(LOG_FILE)) {
      return JSON.parse(fs.readFileSync(LOG_FILE, 'utf-8'));
    }
  } catch (e) {
    console.error('[LOG] Erro ao carregar logs:', e.message);
  }
  return [];
}

function salvarLog(entry) {
  try {
    const logs = carregarLogs();
    logs.unshift(entry); // mais recente primeiro
    fs.writeFileSync(LOG_FILE, JSON.stringify(logs, null, 2), 'utf-8');
  } catch (e) {
    console.error('[LOG] Erro ao salvar log:', e.message);
  }
}

// Verifica limite diário de 25 posts
function podePosta() {
  const logs = carregarLogs();
  const hoje = new Date().toISOString().slice(0, 10);
  const postosHoje = logs.filter((l) => l.date && l.date.startsWith(hoje));
  return postosHoje.length < DAILY_LIMIT;
}

// ---------------------------------------------------------------------------
// Utilitários
// ---------------------------------------------------------------------------

/**
 * Baixa arquivo do Telegram e faz upload para telegra.ph (CDN gratuito aceito pela Meta).
 * Retorna a URL pública permanente.
 */
async function baixarArquivoTelegram(fileId, extensao) {
  const filePath = `${TMP_DIR}/${fileId}.${extensao}`;

  // 1. Obtém a URL do arquivo no Telegram
  const fileInfo = await bot.getFile(fileId);
  const telegramUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${fileInfo.file_path}`;

  // 2. Baixa o arquivo
  const response = await axios.get(telegramUrl, { responseType: 'arraybuffer' });
  fs.writeFileSync(filePath, Buffer.from(response.data));
  console.log(`[DOWNLOAD] Arquivo salvo: ${filePath}`);

  // 3. Faz upload para 0x0.st (CDN público sem autenticação)
  const FormData = require('form-data');
  const form = new FormData();
  form.append('file', fs.createReadStream(filePath), {
    filename: `image.${extensao}`,
    contentType: extensao === 'mp4' ? 'video/mp4' : 'image/jpeg',
  });

  const upload = await axios.post('https://0x0.st', form, {
    headers: form.getHeaders(),
    timeout: 30000,
  });

  const publicUrl = upload.data.trim();
  console.log(`[UPLOAD] URL pública: ${publicUrl}`);

  // 4. Remove arquivo local após upload
  try { fs.unlinkSync(filePath); } catch(e) {}

  return publicUrl;
}

/**
 * Retorna a URL pública da mídia.
 * Se já for uma URL (começa com http), retorna direto.
 */
function gerarUrlPublica(localPath) {
  if (localPath && localPath.startsWith('http')) return localPath;
  if (!PUBLIC_BASE_URL) return null;
  const filename = path.basename(localPath);
  return `${PUBLIC_BASE_URL}/media/${filename}`;
}

/**
 * Remove arquivos temporários de uma sessão.
 */
function limparTmp(mediaFiles) {
  for (const m of mediaFiles) {
    try {
      // Ignora URLs do Telegram — não há arquivo local para remover
      if (m.filePath && !m.filePath.startsWith('http') && fs.existsSync(m.filePath)) { // já limpo no upload
        fs.unlinkSync(m.filePath);
        console.log(`[TMP] Removido: ${m.filePath}`);
      }
    } catch (e) {
      console.error('[TMP] Erro ao remover arquivo:', e.message);
    }
  }
}

// ---------------------------------------------------------------------------
// Meta Graph API — funções de publicação
// ---------------------------------------------------------------------------

const META_API = 'https://graph.facebook.com/v21.0';

/**
 * Cria container de mídia para foto no Instagram.
 * @param {string} imageUrl — URL pública da imagem
 * @param {string} caption — Legenda do post
 * @returns {string} creationId
 */
async function criarContainerFoto(imageUrl, caption) {
  const response = await axios.post(
    `${META_API}/${IG_USER_ID}/media`,
    null,
    {
      params: {
        image_url: imageUrl,
        caption: caption,
        access_token: META_TOKEN,
      },
    }
  );
  return response.data.id;
}

/**
 * Cria container de vídeo (Reel) no Instagram.
 * @param {string} videoUrl — URL pública do vídeo
 * @param {string} caption — Legenda
 * @returns {string} creationId
 */
async function criarContainerVideo(videoUrl, caption) {
  const response = await axios.post(
    `${META_API}/${IG_USER_ID}/media`,
    null,
    {
      params: {
        media_type: 'REELS',
        video_url: videoUrl,
        caption: caption,
        share_to_feed: true,
        access_token: META_TOKEN,
      },
    }
  );
  return response.data.id;
}

/**
 * Cria um item de carrossel (foto individual sem publicar).
 * @param {string} imageUrl — URL pública
 * @returns {string} itemId
 */
async function criarItemCarrossel(imageUrl) {
  const response = await axios.post(
    `${META_API}/${IG_USER_ID}/media`,
    null,
    {
      params: {
        image_url: imageUrl,
        is_carousel_item: true,
        access_token: META_TOKEN,
      },
    }
  );
  return response.data.id;
}

/**
 * Cria container de carrossel com os IDs dos itens.
 * @param {string[]} itemIds — Array de IDs dos itens
 * @param {string} caption — Legenda
 * @returns {string} creationId
 */
async function criarContainerCarrossel(itemIds, caption) {
  const response = await axios.post(
    `${META_API}/${IG_USER_ID}/media`,
    null,
    {
      params: {
        media_type: 'CAROUSEL',
        children: itemIds.join(','),
        caption: caption,
        access_token: META_TOKEN,
      },
    }
  );
  return response.data.id;
}

/**
 * Publica um container de mídia já criado.
 * @param {string} creationId
 * @returns {string} mediaId do post publicado
 */
async function publicarContainer(creationId) {
  const response = await axios.post(
    `${META_API}/${IG_USER_ID}/media_publish`,
    null,
    {
      params: {
        creation_id: creationId,
        access_token: META_TOKEN,
      },
    }
  );
  return response.data.id;
}

/**
 * Consulta o status de processamento de um container de vídeo.
 * @param {string} creationId
 * @returns {string} status: 'FINISHED' | 'IN_PROGRESS' | 'ERROR' | etc.
 */
async function consultarStatusContainer(creationId) {
  const response = await axios.get(`${META_API}/${creationId}`, {
    params: {
      fields: 'status_code',
      access_token: META_TOKEN,
    },
  });
  return response.data.status_code;
}

/**
 * Aguarda o processamento do vídeo com polling.
 * Timeout de 5 minutos, polling a cada 10 segundos.
 * @param {string} creationId
 * @returns {boolean} true se FINISHED, false se timeout/erro
 */
async function aguardarProcessamentoVideo(creationId) {
  const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutos
  const POLL_INTERVAL_MS = 10 * 1000; // 10 segundos
  const inicio = Date.now();

  console.log(`[VIDEO] Aguardando processamento do container ${creationId}...`);

  while (Date.now() - inicio < TIMEOUT_MS) {
    try {
      const status = await consultarStatusContainer(creationId);
      console.log(`[VIDEO] Status: ${status}`);

      if (status === 'FINISHED') return true;
      if (status === 'ERROR') {
        console.error('[VIDEO] Erro no processamento do vídeo.');
        return false;
      }

      // Aguarda antes do próximo polling
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    } catch (e) {
      console.error('[VIDEO] Erro ao consultar status:', e.message);
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }

  console.error('[VIDEO] Timeout: vídeo não processou em 5 minutos.');
  return false;
}

/**
 * Busca os últimos N posts do Instagram.
 * @param {number} limite
 * @returns {Array} lista de posts
 */
async function buscarUltimosPosts(limite = 3) {
  const response = await axios.get(`${META_API}/${IG_USER_ID}/media`, {
    params: {
      fields: 'id,caption,media_type,timestamp,permalink',
      limit: limite,
      access_token: META_TOKEN,
    },
  });
  return response.data.data || [];
}

// ---------------------------------------------------------------------------
// Fluxo principal de postagem
// ---------------------------------------------------------------------------

/**
 * Executa o processo completo de publicação com base na sessão.
 * Retorna o permalink do post publicado ou lança erro.
 */
async function executarPostagem(session, chatId) {
  const { mediaType, mediaFiles, caption } = session;

  if (!podePosta()) {
    throw new Error(
      `Limite diário de ${DAILY_LIMIT} posts atingido. Tente amanhã.`
    );
  }

  let mediaId;

  if (mediaType === 'photo') {
    // --- Foto simples ---
    const localPath = mediaFiles[0].filePath;
    const publicUrl = gerarUrlPublica(localPath);

    if (!publicUrl) {
      throw new Error(
        'PUBLIC_BASE_URL não configurado. Configure no .env ou use URL externa.'
      );
    }

    await bot.sendMessage(chatId, 'Criando container de foto...');
    const creationId = await criarContainerFoto(publicUrl, caption);

    await bot.sendMessage(chatId, 'Publicando foto no Instagram...');
    mediaId = await publicarContainer(creationId);

  } else if (mediaType === 'video') {
    // --- Vídeo / Reel ---
    const localPath = mediaFiles[0].filePath;
    const publicUrl = gerarUrlPublica(localPath);

    if (!publicUrl) {
      throw new Error(
        'PUBLIC_BASE_URL não configurado. Para vídeos, é obrigatório ter uma URL pública.'
      );
    }

    await bot.sendMessage(chatId, 'Criando container de Reel...');
    const creationId = await criarContainerVideo(publicUrl, caption);

    await bot.sendMessage(
      chatId,
      'Processando vídeo... Isso pode levar alguns minutos.'
    );

    const processou = await aguardarProcessamentoVideo(creationId);

    if (!processou) {
      throw new Error(
        'O vídeo não foi processado pelo Instagram. Verifique o formato (MP4, H.264) e tente novamente.'
      );
    }

    await bot.sendMessage(chatId, 'Publicando Reel no Instagram...');
    mediaId = await publicarContainer(creationId);

  } else if (mediaType === 'carousel') {
    // --- Carrossel ---
    await bot.sendMessage(chatId, `Criando ${mediaFiles.length} itens do carrossel...`);

    const itemIds = [];
    for (const m of mediaFiles) {
      const publicUrl = gerarUrlPublica(m.filePath);
      if (!publicUrl) {
        throw new Error('PUBLIC_BASE_URL não configurado para carrossel.');
      }
      const itemId = await criarItemCarrossel(publicUrl);
      itemIds.push(itemId);
    }

    await bot.sendMessage(chatId, 'Criando container do carrossel...');
    const creationId = await criarContainerCarrossel(itemIds, caption);

    await bot.sendMessage(chatId, 'Publicando carrossel no Instagram...');
    mediaId = await publicarContainer(creationId);
  }

  // Busca o permalink do post publicado
  const postInfo = await axios.get(`${META_API}/${mediaId}`, {
    params: {
      fields: 'permalink',
      access_token: META_TOKEN,
    },
  });

  const permalink = postInfo.data.permalink || `https://www.instagram.com/p/${mediaId}/`;

  // Registra no log
  salvarLog({
    date: new Date().toISOString(),
    mediaId,
    mediaType,
    caption: caption.slice(0, 100),
    permalink,
    chatId,
  });

  return permalink;
}

// ---------------------------------------------------------------------------
// Servidor HTTP simples para servir arquivos de mídia temporários
// ---------------------------------------------------------------------------

/**
 * Inicia um servidor HTTP local que serve arquivos do diretório tmp/.
 * Necessário quando PUBLIC_BASE_URL aponta para este processo.
 * Em produção no Railway, o Railway expõe a porta automaticamente.
 */
function iniciarServidorMidia() {
  const PORT = process.env.PORT || 3000;

  const server = http.createServer((req, res) => {
    // Rota: GET /media/:filename
    const match = req.url.match(/^\/media\/(.+)$/);
    if (!match) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const filename = path.basename(match[1]); // segurança: evita path traversal
    const filePath = path.join(TMP_DIR, filename);

    if (!fs.existsSync(filePath)) {
      res.writeHead(404);
      res.end('File not found');
      return;
    }

    // Detecta o content-type pela extensão
    const ext = path.extname(filename).toLowerCase();
    const contentTypes = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.mp4': 'video/mp4',
      '.mov': 'video/quicktime',
    };
    const contentType = contentTypes[ext] || 'application/octet-stream';

    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
  });

  server.listen(PORT, () => {
    console.log(`[SERVIDOR] Servindo mídia em http://0.0.0.0:${PORT}/media/`);
  });

  return server;
}

// ---------------------------------------------------------------------------
// Inicialização do Bot Telegram
// ---------------------------------------------------------------------------

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

console.log('[BOT] Iniciando bot Telegram...');

// ---------------------------------------------------------------------------
// Guard: rejeita mensagens de chats não autorizados
// ---------------------------------------------------------------------------

function isAutorizado(chatId) {
  return chatId === ALLOWED_CHAT_ID;
}

// ---------------------------------------------------------------------------
// Handler de álbum (mídia group = carrossel)
// ---------------------------------------------------------------------------

/**
 * O Telegram envia fotos de um álbum como mensagens separadas com o mesmo
 * media_group_id. Precisamos agrupar antes de processar.
 */
const albumBuffers = {}; // mediaGroupId → { timer, messages: [] }

function processarAlbum(chatId, messages) {
  const session = getSession(chatId);
  session.mediaType = 'carousel';
  session.step = 'waiting_caption';
  session.mediaFiles = messages.map((m) => ({
    fileId: m.photo ? m.photo[m.photo.length - 1].file_id : null,
    type: 'photo',
    filePath: null, // será baixado depois
  }));

  // Verifica se o álbum já veio com legenda
  const primeiraComCaption = messages.find((m) => m.caption);
  if (primeiraComCaption) {
    session.caption = primeiraComCaption.caption;
    session.step = 'waiting_confirm';
    enviarConfirmacao(chatId, session);
  } else {
    bot.sendMessage(
      chatId,
      `Recebi ${messages.length} fotos para o carrossel!\n\nAgora me manda a legenda do post:`
    );
  }
}

// ---------------------------------------------------------------------------
// Funções de interação com o usuário
// ---------------------------------------------------------------------------

async function enviarConfirmacao(chatId, session) {
  const tipo =
    session.mediaType === 'photo'
      ? 'Foto'
      : session.mediaType === 'video'
      ? 'Reel (Vídeo)'
      : `Carrossel (${session.mediaFiles.length} fotos)`;

  const legendaPreview =
    session.caption.length > 200
      ? session.caption.slice(0, 200) + '...'
      : session.caption;

  const mensagem =
    `Pronto para postar!\n\n` +
    `Tipo: ${tipo}\n` +
    `Legenda: ${legendaPreview}\n\n` +
    `Responda:\n` +
    `SIM — postar agora\n` +
    `HH:MM — agendar para esse horário (ex: 14:30)\n` +
    `NAO — cancelar`;

  await bot.sendMessage(chatId, mensagem);
  session.step = 'waiting_confirm';
  console.log('[CONFIRMACAO] Mensagem de confirmação enviada para chatId:', chatId);
}

// ---------------------------------------------------------------------------
// Handlers de comandos
// ---------------------------------------------------------------------------

// /start — boas-vindas
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;

  if (!isAutorizado(chatId)) {
    await bot.sendMessage(chatId, 'Acesso negado.');
    console.log(`[SEGURANÇA] Chat não autorizado: ${chatId}`);
    return;
  }

  await bot.sendMessage(
    chatId,
    `Oi, Juliana! Sou seu bot de Instagram.\n\n` +
      `Como usar:\n` +
      `1. Me mande uma foto, vídeo ou álbum de fotos\n` +
      `2. Adicione a legenda (na caption ou na próxima mensagem)\n` +
      `3. Confirme o post\n\n` +
      `Comandos:\n` +
      `/status — ver últimos 3 posts\n` +
      `/agendar — ver posts agendados\n` +
      `/cancelar — cancelar post atual`
  );
});

// /status — últimos 3 posts do Instagram
bot.onText(/\/status/, async (msg) => {
  const chatId = msg.chat.id;
  if (!isAutorizado(chatId)) return;

  try {
    await bot.sendMessage(chatId, 'Buscando seus últimos posts...');
    const posts = await buscarUltimosPosts(3);

    if (posts.length === 0) {
      await bot.sendMessage(chatId, 'Nenhum post encontrado.');
      return;
    }

    let resposta = 'Seus últimos 3 posts:\n\n';
    for (const post of posts) {
      const data = new Date(post.timestamp).toLocaleDateString('pt-BR');
      const legenda = post.caption
        ? post.caption.slice(0, 80) + (post.caption.length > 80 ? '...' : '')
        : '(sem legenda)';
      resposta += `${data} — ${post.media_type}\n${legenda}\n${post.permalink}\n\n`;
    }

    await bot.sendMessage(chatId, resposta);
  } catch (e) {
    console.error('[/status] Erro:', e.response?.data || e.message);
    await bot.sendMessage(
      chatId,
      `Erro ao buscar posts: ${e.response?.data?.error?.message || e.message}`
    );
  }
});

// /agendar — lista posts agendados
bot.onText(/\/agendar/, async (msg) => {
  const chatId = msg.chat.id;
  if (!isAutorizado(chatId)) return;

  if (scheduledPosts.length === 0) {
    await bot.sendMessage(chatId, 'Nenhum post agendado no momento.');
    return;
  }

  let resposta = 'Posts agendados:\n\n';
  for (const p of scheduledPosts) {
    const horario = p.scheduledTime.toLocaleTimeString('pt-BR', {
      hour: '2-digit',
      minute: '2-digit',
    });
    const tipo = p.mediaType;
    const legenda = p.caption.slice(0, 60);
    resposta += `${horario} — ${tipo}: ${legenda}...\n`;
  }

  await bot.sendMessage(chatId, resposta);
});

// /cancelar — cancela o post em andamento
bot.onText(/\/cancelar/, async (msg) => {
  const chatId = msg.chat.id;
  if (!isAutorizado(chatId)) return;

  const session = getSession(chatId);
  limparTmp(session.mediaFiles);
  resetSession(chatId);

  await bot.sendMessage(chatId, 'Post cancelado. Pode me mandar a próxima mídia quando quiser.');
});

// ---------------------------------------------------------------------------
// Handler principal de mensagens
// ---------------------------------------------------------------------------

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;

  // Ignora chats não autorizados
  if (!isAutorizado(chatId)) return;

  // Ignora comandos (já tratados acima)
  if (msg.text && msg.text.startsWith('/')) return;

  const session = getSession(chatId);

  // -------------------------------------------------------------------
  // 1. Recebe FOTO
  // -------------------------------------------------------------------
  if (msg.photo) {
    // Verifica se faz parte de um álbum (carrossel)
    if (msg.media_group_id) {
      const groupId = msg.media_group_id;

      if (!albumBuffers[groupId]) {
        albumBuffers[groupId] = { messages: [], timer: null };
      }

      albumBuffers[groupId].messages.push(msg);

      // Cancela timer anterior e seta um novo (aguarda 1.5s para coletar todas as fotos do álbum)
      if (albumBuffers[groupId].timer) {
        clearTimeout(albumBuffers[groupId].timer);
      }

      albumBuffers[groupId].timer = setTimeout(() => {
        const msgs = albumBuffers[groupId].messages;
        delete albumBuffers[groupId];
        processarAlbum(chatId, msgs);
      }, 1500);

      return;
    }

    // Foto simples
    const fileId = msg.photo[msg.photo.length - 1].file_id; // maior resolução

    resetSession(chatId);
    session.mediaType = 'photo';
    session.mediaFiles = [{ fileId, type: 'photo', filePath: null }];

    if (msg.caption) {
      session.caption = msg.caption;
      await baixarMidiasSessao(session);
      await enviarConfirmacao(chatId, session);
    } else {
      session.step = 'waiting_caption';
      await bot.sendMessage(chatId, 'Foto recebida! Agora me manda a legenda do post:');
    }
    return;
  }

  // -------------------------------------------------------------------
  // 2. Recebe VÍDEO
  // -------------------------------------------------------------------
  if (msg.video || msg.document) {
    const fileObj = msg.video || msg.document;
    const fileId = fileObj.file_id;

    // Validação básica de tamanho (50MB = limite do Telegram para bots)
    if (fileObj.file_size && fileObj.file_size > 50 * 1024 * 1024) {
      await bot.sendMessage(
        chatId,
        'Vídeo muito grande para o Telegram (limite 50MB). Use o Google Drive ou Dropbox e me mande a URL direta.'
      );
      return;
    }

    resetSession(chatId);
    session.mediaType = 'video';
    session.mediaFiles = [{ fileId, type: 'video', filePath: null }];

    if (msg.caption) {
      session.caption = msg.caption;
      await bot.sendMessage(chatId, 'Vídeo recebido! Baixando...');
      await baixarMidiasSessao(session);
      await enviarConfirmacao(chatId, session);
    } else {
      session.step = 'waiting_caption';
      await bot.sendMessage(chatId, 'Vídeo recebido! Agora me manda a legenda do Reel:');
    }
    return;
  }

  // -------------------------------------------------------------------
  // 3. Recebe TEXTO
  // -------------------------------------------------------------------
  if (msg.text) {
    const texto = msg.text.trim();

    // Aguardando legenda
    if (session.step === 'waiting_caption') {
      session.caption = texto;

      // Baixa os arquivos agora (se ainda não baixou)
      await bot.sendMessage(chatId, 'Legenda recebida! Baixando mídia...');
      await baixarMidiasSessao(session);
      await enviarConfirmacao(chatId, session);
      return;
    }

    // Aguardando confirmação
    if (session.step === 'waiting_confirm') {
      const upper = texto.toUpperCase();

      // SIM — postar agora
      if (upper === 'SIM' || upper === 'S') {
        await bot.sendMessage(chatId, 'Postando agora...');
        console.log('[POSTAGEM] Iniciando postagem para chatId:', chatId);
        console.log('[POSTAGEM] Tipo de mídia:', session.mediaType);
        console.log('[POSTAGEM] Arquivo:', session.mediaFiles[0]?.filePath);

        try {
          const permalink = await executarPostagem(session, chatId);
          await bot.sendMessage(
            chatId,
            `Post publicado com sucesso!\n${permalink}`
          );
          console.log('[POSTAGEM] Sucesso:', permalink);
        } catch (e) {
          console.error('[POSTAGEM] Erro status:', e.response?.status);
          console.error('[POSTAGEM] Erro data:', JSON.stringify(e.response?.data, null, 2));
          console.error('[POSTAGEM] Erro message:', e.message);
          await bot.sendMessage(
            chatId,
            `Erro ao publicar: ${e.response?.data?.error?.message || e.message}`
          );
        } finally {
          limparTmp(session.mediaFiles);
          resetSession(chatId);
        }
        return;
      }

      // NAO — cancelar
      if (upper === 'NAO' || upper === 'NÃO' || upper === 'N') {
        limparTmp(session.mediaFiles);
        resetSession(chatId);
        await bot.sendMessage(chatId, 'Post cancelado.');
        return;
      }

      // HH:MM — agendar
      const horarioMatch = texto.match(/^(\d{1,2}):(\d{2})$/);
      if (horarioMatch) {
        const hora = parseInt(horarioMatch[1], 10);
        const minuto = parseInt(horarioMatch[2], 10);

        if (hora < 0 || hora > 23 || minuto < 0 || minuto > 59) {
          await bot.sendMessage(chatId, 'Horário inválido. Use o formato HH:MM (ex: 14:30)');
          return;
        }

        const agendado = new Date();
        agendado.setHours(hora, minuto, 0, 0);

        // Se o horário já passou hoje, agenda para amanhã
        if (agendado <= new Date()) {
          agendado.setDate(agendado.getDate() + 1);
        }

        // Salva o agendamento
        const postAgendado = {
          chatId,
          session: { ...session, mediaFiles: [...session.mediaFiles] },
          scheduledTime: agendado,
          mediaType: session.mediaType,
          caption: session.caption,
        };

        scheduledPosts.push(postAgendado);

        // Configura cron para disparar no horário
        const cronExpr = `${minuto} ${hora} * * *`;
        const task = cron.schedule(
          cronExpr,
          async () => {
            console.log(`[CRON] Executando post agendado para ${chatId}`);
            try {
              const permalink = await executarPostagem(postAgendado.session, chatId);
              await bot.sendMessage(
                chatId,
                `Post agendado publicado!\n${permalink}`
              );
            } catch (e) {
              await bot.sendMessage(
                chatId,
                `Erro no post agendado: ${e.response?.data?.error?.message || e.message}`
              );
            } finally {
              limparTmp(postAgendado.session.mediaFiles);
              // Remove da lista de agendados
              const idx = scheduledPosts.indexOf(postAgendado);
              if (idx > -1) scheduledPosts.splice(idx, 1);
              task.stop();
            }
          },
          { timezone: 'America/Sao_Paulo' }
        );

        const horarioFormatado = agendado.toLocaleString('pt-BR', {
          dateStyle: 'short',
          timeStyle: 'short',
          timeZone: 'America/Sao_Paulo',
        });

        resetSession(chatId); // limpa sessão ativa (post está no agendado)
        await bot.sendMessage(
          chatId,
          `Post agendado para ${horarioFormatado}! Use /agendar para ver os posts agendados.`
        );
        return;
      }

      // Resposta não reconhecida
      await bot.sendMessage(
        chatId,
        'Não entendi. Responda:\nSIM — postar agora\nHH:MM — agendar (ex: 14:30)\nNAO — cancelar'
      );
      return;
    }

    // Mensagem de texto sem contexto
    if (session.step === 'idle') {
      await bot.sendMessage(
        chatId,
        'Me mande uma foto, vídeo ou álbum de fotos para começar a postar no Instagram.'
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Baixa todas as mídias da sessão de forma sequencial
// ---------------------------------------------------------------------------

async function baixarMidiasSessao(session) {
  for (const m of session.mediaFiles) {
    if (m.filePath) continue; // já baixado

    const ext = m.type === 'video' ? 'mp4' : 'jpg';

    try {
      m.filePath = await baixarArquivoTelegram(m.fileId, ext);
    } catch (e) {
      console.error('[DOWNLOAD] Erro ao baixar mídia:', e.message);
      throw new Error(`Não foi possível baixar a mídia: ${e.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Tratamento de erros globais do bot
// ---------------------------------------------------------------------------

bot.on('polling_error', (error) => {
  console.error('[POLLING ERROR]', error.code, error.message);
});

bot.on('error', (error) => {
  console.error('[BOT ERROR]', error.message);
});

process.on('uncaughtException', (error) => {
  console.error('[UNCAUGHT EXCEPTION]', error);
});

process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION]', reason);
});

// ---------------------------------------------------------------------------
// Inicialização
// ---------------------------------------------------------------------------

// Inicia servidor de mídia se PUBLIC_BASE_URL estiver configurado
if (PUBLIC_BASE_URL) {
  iniciarServidorMidia();
}

console.log('[BOT] Bot iniciado e aguardando mensagens...');
console.log(`[BOT] Chat autorizado: ${ALLOWED_CHAT_ID}`);
console.log(`[BOT] Instagram User ID: ${IG_USER_ID}`);
console.log(`[BOT] Token Meta (primeiros 10 chars): ${META_TOKEN ? META_TOKEN.substring(0, 10) : 'NAO CONFIGURADO'}`);
console.log(
  `[BOT] URL pública de mídia: ${PUBLIC_BASE_URL || 'NAO CONFIGURADA (somente fotos via URL externa)'}`
);

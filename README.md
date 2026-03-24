# Bot Telegram → Instagram | @julianarickli

Bot Node.js que recebe fotos, vídeos e álbuns no Telegram e publica diretamente
no Instagram Business via Meta Graph API.

---

## Pré-requisitos

- Node.js 18 ou superior
- Conta Business no Instagram vinculada a uma Facebook Page
- Token Meta com permissão `instagram_content_publish`

---

## Passo 1 — Criar o bot no BotFather e obter o token

1. Abra o Telegram e procure por **@BotFather**
2. Envie o comando `/newbot`
3. Escolha um nome para o bot (ex: `Juliana Instagram Bot`)
4. Escolha um username terminando em `bot` (ex: `julianarickli_ig_bot`)
5. O BotFather vai te enviar o **token** — copie e cole em `TELEGRAM_BOT_TOKEN` no `.env`

Exemplo de token: `7123456789:AAHzKbP8L3x_exampleTokenABC123`

---

## Passo 2 — Obter o seu CHAT_ID no Telegram

Depois de criar o bot:

1. Abra uma conversa com o seu bot no Telegram
2. Envie qualquer mensagem (ex: `/start`)
3. Acesse a URL abaixo no navegador, substituindo `SEU_TOKEN`:

```
https://api.telegram.org/botSEU_TOKEN/getUpdates
```

4. Procure no JSON o campo `"id"` dentro de `"chat"` — esse é o seu `CHAT_ID`
5. Cole esse número em `ALLOWED_CHAT_ID` no `.env`

> O `ALLOWED_CHAT_ID` garante que apenas você pode controlar o bot.

---

## Passo 3 — Gerar o token Meta com permissão `instagram_content_publish`

### Opção A: Meta for Developers (recomendado para produção)

1. Acesse [developers.facebook.com](https://developers.facebook.com)
2. Clique em **Meus Apps** e crie um novo app do tipo **Business**
3. Adicione o produto **Instagram Graph API**
4. Em **Ferramentas > Explorador de API do Graph**:
   - Selecione seu app
   - Clique em **Gerar token de acesso do usuário**
   - Marque as permissões:
     - `instagram_basic`
     - `instagram_content_publish`
     - `pages_read_engagement`
5. Copie o token gerado e cole em `META_ACCESS_TOKEN` no `.env`

> **Atenção:** Tokens de usuário expiram em 60 dias. Para produção, gere um
> **token de longa duração** usando o endpoint:
> ```
> GET /oauth/access_token?grant_type=fb_exchange_token&client_id={app-id}&client_secret={app-secret}&fb_exchange_token={short-lived-token}
> ```

### Opção B: Token permanente via System User (avançado)

1. Acesse o **Business Manager** da sua empresa
2. Vá em **Configurações do Business > Usuários do Sistema**
3. Crie um usuário do sistema e atribua os ativos (Instagram Business)
4. Gere um token sem expiração com as permissões necessárias

---

## Passo 4 — Configurar o arquivo .env

```bash
# Copie o arquivo de exemplo
cp .env.example .env

# Edite com seus dados
nano .env
```

Preencha todos os campos:

```env
TELEGRAM_BOT_TOKEN=7123456789:AAHzKbP8L3x...
META_ACCESS_TOKEN=EAABsbCS...
IG_USER_ID=17841408506308848
FB_PAGE_ID=113851924548325
ALLOWED_CHAT_ID=123456789
PUBLIC_BASE_URL=https://meu-bot.railway.app
```

---

## Passo 5 — Instalar dependências e rodar

```bash
cd bot-telegram
npm install
node index.js
```

Você deve ver:

```
[BOT] Bot iniciado e aguardando mensagens...
[BOT] Chat autorizado: 123456789
[BOT] Instagram User ID: 17841408506308848
[SERVIDOR] Servindo mídia em http://0.0.0.0:3000/media/
```

---

## Como usar o bot

### Postar uma foto

1. Abra o Telegram e entre na conversa com seu bot
2. Envie uma foto
   - Se quiser, já adicione a legenda na **caption** da foto
   - Ou espere o bot pedir a legenda na próxima mensagem
3. O bot vai mostrar um preview e perguntar se quer postar
4. Responda:
   - `SIM` — publica imediatamente
   - `14:30` — agenda para as 14h30 (horário de Brasília)
   - `NAO` — cancela

### Postar um Reel (vídeo)

1. Envie o vídeo pelo Telegram (limite: 50MB)
   - Formatos aceitos: MP4, MOV
   - Para vídeos maiores, use a opcao de URL externa (ver abaixo)
2. Adicione a legenda quando solicitado
3. Confirme o post

> O Instagram processa vídeos em background. O bot vai aguardar até 5 minutos
> pelo processamento antes de publicar.

### Postar um carrossel (álbum de fotos)

1. Selecione várias fotos no Telegram e envie como **álbum**
   - No celular: toque no clipe > selecione múltiplas fotos
   - No computador: selecione múltiplas fotos e envie juntas
2. O bot vai detectar automaticamente que é um carrossel
3. Adicione a legenda e confirme

### Comandos disponíveis

| Comando | O que faz |
|---------|-----------|
| `/start` | Boas-vindas e instruções |
| `/status` | Mostra os 3 últimos posts do Instagram |
| `/agendar` | Lista posts agendados |
| `/cancelar` | Cancela o post em andamento |

---

## Hospedagem do bot

O bot precisa ficar rodando 24/7 para funcionar. Opções:

### Railway.app (recomendado — gratuito para começar)

1. Crie uma conta em [railway.app](https://railway.app)
2. Clique em **New Project > Deploy from GitHub repo**
3. Conecte seu repositório
4. Vá em **Variables** e adicione todas as variáveis do `.env`
5. O Railway vai detectar o `package.json` e rodar `npm start` automaticamente
6. Copie a URL do projeto (ex: `https://meu-bot.railway.app`) e cole em `PUBLIC_BASE_URL`

### VPS com PM2 (mais controle)

```bash
# Instala PM2 globalmente
npm install -g pm2

# Inicia o bot com PM2
pm2 start index.js --name "instagram-bot"

# Salva para reiniciar automaticamente
pm2 save
pm2 startup
```

---

## Vídeos maiores que 50MB

O Telegram tem limite de 50MB para bots. Para vídeos maiores:

1. Faça upload do vídeo no Google Drive ou Dropbox
2. Gere um link de compartilhamento público direto
3. No Google Drive, substitua `/view` por `/uc?export=download` na URL
4. Envie a URL como mensagem de texto para o bot (em breve: suporte nativo)

---

## Estrutura do projeto

```
bot-telegram/
├── index.js          -- Bot principal
├── package.json      -- Dependências
├── .env              -- Variáveis de ambiente (NÃO versionar)
├── .env.example      -- Exemplo de configuração
├── logs/
│   └── posts.json    -- Histórico de posts publicados
└── tmp/              -- Arquivos temporários (limpos após postagem)
```

---

## Limites da Meta API

- Máximo de **25 posts por dia** (limite imposto pela API)
- O bot avisa quando o limite diário for atingido
- Vídeos devem ser MP4 com codec H.264
- Duração mínima de Reels: 3 segundos | máxima: 15 minutos
- Carrossel: mínimo 2 fotos, máximo 10 fotos

---

## Solução de problemas

**Bot não responde**
- Verifique se `TELEGRAM_BOT_TOKEN` está correto
- Verifique se `ALLOWED_CHAT_ID` é o seu chat ID correto

**Erro "instagram_content_publish permission is required"**
- Seu token Meta ainda não tem essa permissão
- Siga o Passo 3 para gerar um token com as permissões corretas

**Erro ao baixar vídeo do Telegram**
- Vídeos acima de 50MB não podem ser baixados via API do Telegram
- Use um link externo (Google Drive, Dropbox)

**Post de vídeo fica em "Processando" por muito tempo**
- Verifique se o vídeo está em formato MP4 com codec H.264
- O Instagram pode rejeitar vídeos com problemas de codec
- Timeout máximo: 5 minutos

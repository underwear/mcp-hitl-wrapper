import { Bot, InlineKeyboard } from 'grammy';
import type { HitlDriver, HitlRequest, HitlResponse, MessageUpdate } from './interface.js';
import type { TelegramDestinationConfig } from '../../config/schema.js';
import { getLogger } from '../../utils/logger.js';

const log = getLogger('hitl:telegram');

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatParams(params: Record<string, unknown>, maxLen = 1500): string {
  const json = JSON.stringify(params, null, 2);
  if (json.length <= maxLen) return escapeHtml(json);
  return escapeHtml(json.substring(0, maxLen) + '\n...(truncated)');
}

function formatTimeoutDisplay(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return min > 0 ? `${min}:${sec.toString().padStart(2, '0')}` : `${sec}s`;
}

function buildRequestMessage(req: HitlRequest): string {
  const lines = [
    '🔔 <b>HITL Approval Request</b>',
    '',
  ];

  if (req.agent) lines.push(`<b>Agent:</b> ${escapeHtml(req.agent)}`);
  lines.push(`<b>MCP:</b> ${escapeHtml(req.mcpName)}`);
  lines.push(`<b>Tool:</b> ${escapeHtml(req.toolName)}`);
  lines.push('');

  if (req.reason) {
    lines.push(`<b>Reason:</b> ${escapeHtml(req.reason)}`);
  }
  if (req.content) {
    lines.push(`<b>Content:</b> ${escapeHtml(req.content)}`);
  }

  lines.push('');
  lines.push('<b>Parameters:</b>');
  lines.push(`<pre>${formatParams(req.params)}</pre>`);
  lines.push('');
  lines.push(`⏱ Auto-reject in ${formatTimeoutDisplay(req.timeout)}`);

  return lines.join('\n');
}

function buildResultMessage(req: HitlRequest, update: MessageUpdate): string {
  const icon = update.decision === 'approved' ? '✅' : update.decision === 'rejected' ? '❌' : '⏱';
  const label = update.decision === 'approved' ? 'Approved' : update.decision === 'rejected' ? 'Rejected' : 'Timed out';

  const lines = [
    `${icon} <b>${label}</b> by ${escapeHtml(update.decidedBy)}`,
    '',
  ];

  if (req.agent) lines.push(`<b>Agent:</b> ${escapeHtml(req.agent)}`);
  lines.push(`<b>MCP:</b> ${escapeHtml(req.mcpName)}`);
  lines.push(`<b>Tool:</b> ${escapeHtml(req.toolName)}`);

  if (req.reason) {
    lines.push(`<b>Reason:</b> ${escapeHtml(req.reason)}`);
  }

  lines.push('');
  lines.push('<b>Parameters:</b>');
  lines.push(`<pre>${formatParams(req.params)}</pre>`);

  if (update.elapsed !== undefined) {
    lines.push('');
    lines.push(`⏱ Response time: ${(update.elapsed / 1000).toFixed(1)}s`);
  }

  return lines.join('\n');
}

export class TelegramDriver implements HitlDriver {
  private bot: Bot;
  private chatId: string;
  private callback?: (messageId: string, response: HitlResponse) => void;
  private requestsByMessageId = new Map<string, HitlRequest>();

  constructor(private config: TelegramDestinationConfig) {
    this.bot = new Bot(config.botToken);
    this.chatId = String(config.chatId);
  }

  async start(): Promise<void> {
    this.bot.on('callback_query:data', async (ctx) => {
      const data = ctx.callbackQuery.data;
      if (!data) return;

      const [action, requestId] = data.split(':');
      if (!requestId || (action !== 'approve' && action !== 'reject')) return;

      const decision = action === 'approve' ? 'approved' : 'rejected';
      const decidedBy = ctx.callbackQuery.from.username
        ?? ctx.callbackQuery.from.first_name
        ?? 'unknown';

      await ctx.answerCallbackQuery({
        text: decision === 'approved' ? '✅ Approved' : '❌ Rejected',
      });

      log.info({ requestId, decision, decidedBy }, 'HITL response received');
      this.callback?.(requestId, { decision: decision as 'approved' | 'rejected', decidedBy });
    });

    this.bot.catch((err) => {
      log.error({ err: err.error }, 'Telegram bot error');
    });

    // bot.start() begins long polling — don't await as it runs until stop()
    // Handle launch errors that would otherwise be unhandled rejections
    this.bot.start().catch((err) => {
      log.error({ err }, 'Telegram bot polling failed');
    });
    log.info('Telegram HITL driver started');
  }

  async sendRequest(request: HitlRequest): Promise<string> {
    const keyboard = new InlineKeyboard()
      .text('✅ Approve', `approve:${request.id}`)
      .text('❌ Reject', `reject:${request.id}`);

    const message = await this.bot.api.sendMessage(this.chatId, buildRequestMessage(request), {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });

    const msgId = String(message.message_id);
    this.requestsByMessageId.set(msgId, request);
    log.info({ requestId: request.id, messageId: msgId }, 'HITL request sent to Telegram');

    return msgId;
  }

  async updateMessage(messageId: string, update: MessageUpdate): Promise<void> {
    const request = this.requestsByMessageId.get(messageId);
    this.requestsByMessageId.delete(messageId);

    try {
      await this.bot.api.editMessageText(
        this.chatId,
        parseInt(messageId, 10),
        request ? buildResultMessage(request, update) : `${update.decision} by ${update.decidedBy}`,
        { parse_mode: 'HTML' },
      );
    } catch (err) {
      log.warn({ messageId, err }, 'Failed to update Telegram message');
    }
  }

  onResponse(callback: (messageId: string, response: HitlResponse) => void): void {
    this.callback = callback;
  }

  async close(): Promise<void> {
    await this.bot.stop();
    this.requestsByMessageId.clear();
    log.info('Telegram HITL driver stopped');
  }
}

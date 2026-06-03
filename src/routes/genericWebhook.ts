import { Router } from 'express';
import { relayIncomingMessage } from '../core/relayPipeline.js';
import { logger } from '../logger.js';
import type { UnifiedMessage } from '../types.js';

type GenericWebhookBody = {
  sourceName?: unknown;
  senderName?: unknown;
  senderId?: unknown;
  content?: unknown;
  sourceUrl?: unknown;
  timestamp?: unknown;
};

const router = Router();

function toStringOrUndefined(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function toDateOrNow(value: unknown): Date {
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      return date;
    }
  }

  return new Date();
}

function normalizeGenericWebhook(body: GenericWebhookBody): UnifiedMessage | null {
  const sourceName = toStringOrUndefined(body.sourceName) ?? 'Generic Webhook';
  const senderName = toStringOrUndefined(body.senderName) ?? 'Unknown Sender';
  const senderId = toStringOrUndefined(body.senderId) ?? 'generic-webhook';
  const content = toStringOrUndefined(body.content);

  if (!content) {
    return null;
  }

  return {
    platform: 'Generic',
    sourceType: 'channel',
    sourceName,
    senderId,
    senderName,
    content,
    timestamp: toDateOrNow(body.timestamp),
    sourceUrl: toStringOrUndefined(body.sourceUrl),
    raw: body,
  };
}

router.post('/', async (req, res) => {
  const normalized = normalizeGenericWebhook(req.body as GenericWebhookBody);
  if (!normalized) {
    res.status(400).json({
      ok: false,
      message: 'Invalid payload: content is required.',
    });
    return;
  }

  try {
    await relayIncomingMessage({
      source: 'generic-webhook',
      message: normalized,
    });

    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, 'Failed to forward generic webhook message');
    res.status(500).json({ ok: false, message: 'Failed to forward webhook message.' });
  }
});

export default router;

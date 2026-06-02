import { Client, validateSignature, type WebhookEvent } from '@line/bot-sdk';
import { Router, type Request } from 'express';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { normalizeLineEvent } from '../normalizer/lineNormalizer.js';
import { sendToSlack } from '../slack/slackNotifier.js';

type RawBodyRequest = Request & { rawBody?: Buffer };
type LineSource = WebhookEvent['source'];

const router = Router();

const lineClient = config.line.enabled
  ? new Client({
      channelAccessToken: config.line.channelAccessToken as string,
    })
  : null;

function getSignature(req: Request): string {
  const signature = req.header('x-line-signature');
  return signature ?? '';
}

function getRawBody(req: RawBodyRequest): string {
  if (!req.rawBody) {
    return '';
  }
  return req.rawBody.toString('utf8');
}

async function getSenderName(event: WebhookEvent): Promise<string | undefined> {
  if (!lineClient) {
    return undefined;
  }

  if (!('source' in event)) {
    return undefined;
  }

  const source = event.source as LineSource;
  const userId = source.userId;
  if (!userId) {
    return undefined;
  }

  try {
    if (source.type === 'user') {
      const profile = await lineClient.getProfile(userId);
      return profile.displayName;
    }

    if (source.type === 'group') {
      const profile = await lineClient.getGroupMemberProfile(source.groupId, userId);
      return profile.displayName;
    }

    if (source.type === 'room') {
      const profile = await lineClient.getRoomMemberProfile(source.roomId, userId);
      return profile.displayName;
    }
  } catch (err) {
    logger.warn({ err, sourceType: source.type, userId }, 'Failed to fetch LINE sender profile');
  }

  return undefined;
}

router.post('/', async (req, res) => {
  if (!config.line.enabled) {
    res.status(503).json({
      ok: false,
      message: 'LINE integration is disabled (missing LINE env).',
    });
    return;
  }

  const rawBody = getRawBody(req as RawBodyRequest);
  const signature = getSignature(req);

  if (!rawBody || !signature) {
    logger.warn('LINE webhook missing signature or raw body');
    res.status(400).json({ ok: false, message: 'Invalid LINE webhook request.' });
    return;
  }

  const isValidSignature = validateSignature(
    rawBody,
    config.line.channelSecret as string,
    signature,
  );

  if (!isValidSignature) {
    logger.warn('LINE signature validation failed');
    res.status(403).json({ ok: false, message: 'Invalid LINE signature.' });
    return;
  }

  const body = req.body as { events?: WebhookEvent[] };
  const events = body.events ?? [];

  for (const event of events) {
    const senderName = await getSenderName(event);
    const normalized = normalizeLineEvent(event, senderName);

    if (!normalized) {
      logger.info(
        { eventType: event.type },
        'Skip unsupported LINE event or non-text message',
      );
      continue;
    }

    try {
      await sendToSlack(normalized);
    } catch (err) {
      logger.error({ err, eventType: event.type }, 'Failed to forward LINE message to Slack');
    }
  }

  res.json({ ok: true });
});

export default router;

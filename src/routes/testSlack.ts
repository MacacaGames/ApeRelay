import { Router } from 'express';
import { sendToSlack } from '../slack/slackNotifier.js';
import { logger } from '../logger.js';
import type { UnifiedMessage } from '../types.js';

const router = Router();

router.post('/', async (_req, res) => {
  const testMsg: UnifiedMessage = {
    platform: 'LINE',
    sourceType: 'group',
    sourceName: 'Test Group',
    senderId: 'test-user-001',
    senderName: 'Test User',
    content: 'ApeRelay 測試訊息 — Slack 轉發正常運作中。',
    timestamp: new Date(),
  };

  try {
    await sendToSlack(testMsg);
    res.json({ ok: true, message: 'Test notification sent to Slack.' });
  } catch (err) {
    logger.error({ err }, 'test-slack endpoint error');
    res.status(500).json({ ok: false, message: 'Failed to send test notification.' });
  }
});

export default router;

import 'dotenv/config';
import express from 'express';
import { config } from './config.js';
import { logger } from './logger.js';
import healthRouter from './routes/health.js';
import testSlackRouter from './routes/testSlack.js';
import lineWebhookRouter from './routes/lineWebhook.js';
import adminRouter from './routes/admin.js';
import { startDiscordClient } from './discord/discordClient.js';

const app = express();

app.use(
  express.json({
    verify: (req, _res, buf) => {
      (req as express.Request & { rawBody?: Buffer }).rawBody = Buffer.from(buf);
    },
  }),
);

app.use('/health', healthRouter);
app.use('/webhook/test-slack', testSlackRouter);
app.use('/webhook/line', lineWebhookRouter);
app.use('/', adminRouter);

app.listen(config.port, () => {
  logger.info({ port: config.port }, 'ApeRelay service started');
  void startDiscordClient();
});

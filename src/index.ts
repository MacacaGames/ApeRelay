import 'dotenv/config';
import express from 'express';
import { config } from './config.js';
import { logger } from './logger.js';
import healthRouter from './routes/health.js';
import testSlackRouter from './routes/testSlack.js';

const app = express();

app.use(express.json());

app.use('/health', healthRouter);
app.use('/webhook/test-slack', testSlackRouter);

app.listen(config.port, () => {
  logger.info({ port: config.port }, 'ApeRelay service started');
});

import { Router } from 'express';
import { handleLineWebhook } from '../sources/lineSource.js';

const router = Router();

router.post('/', handleLineWebhook);

export default router;

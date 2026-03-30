import { Router } from 'express';

export function createHealthRoutes(): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json({ status: 'ok', version: '0.1.0' });
  });

  return router;
}

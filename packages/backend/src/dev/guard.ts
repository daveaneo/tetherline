import type { Request, Response, NextFunction } from 'express';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * Gate /api/dev/* behind dev-mode + loopback. Optional bearer token via
 * TETHERLINE_DEV_TOKEN for paranoid deployments; if unset, only the loopback
 * check applies.
 */
export function devGuard(req: Request, res: Response, next: NextFunction): void {
  if (process.env.NODE_ENV === 'production' && process.env.TETHERLINE_ALLOW_DEV !== '1') {
    res.status(501).json({ error: 'dev endpoints disabled in production' });
    return;
  }

  const addr = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
  if (!LOOPBACK.has(addr) && addr !== '127.0.0.1') {
    res.status(403).json({ error: 'dev endpoints are loopback-only' });
    return;
  }

  const requiredToken = process.env.TETHERLINE_DEV_TOKEN;
  if (requiredToken) {
    const header = req.headers.authorization;
    if (header !== `Bearer ${requiredToken}`) {
      res.status(401).json({ error: 'invalid TETHERLINE_DEV_TOKEN' });
      return;
    }
  }

  next();
}

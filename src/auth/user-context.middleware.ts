import { Injectable, NestMiddleware } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { AuthService } from './auth.service';

// Simple dev-friendly auth:
// - Send header: x-user-email: you@example.com
// In production, replace with real auth (JWT, session, etc.)
@Injectable()
export class UserContextMiddleware implements NestMiddleware {
  constructor(private auth: AuthService) {}

  async use(req: Request & { user?: any }, _res: Response, next: NextFunction) {
    const email = (req.header('x-user-email') || '').trim();
    if (email) {
      req.user = await this.auth.findOrCreateUserByEmail(email);
    }
    next();
  }
}

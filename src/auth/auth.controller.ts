import { Controller, Get, Req } from '@nestjs/common';
import type { Request } from 'express';

@Controller()
export class AuthController {
  @Get('me')
  me(@Req() req: Request & { user?: any }) {
    if (!req.user) return { authenticated: false };
    return { authenticated: true, user: { id: req.user.id, email: req.user.email, name: req.user.name } };
  }
}

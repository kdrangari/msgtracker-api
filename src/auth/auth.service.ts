import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AuthService {
  constructor(private prisma: PrismaService) {}

  async findOrCreateUserByEmail(email: string, name?: string) {
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) return existing;
    return this.prisma.user.create({ data: { email, name } });
  }
}

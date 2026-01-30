import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { GmailModule } from './gmail/gmail.module';
import { WhatsappModule } from './whatsapp/whatsapp.module';
import { ReportsModule } from './reports/reports.module';
import { HealthController } from './common/health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    PrismaModule,
    AuthModule,
    GmailModule,
    WhatsappModule,
    ReportsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}

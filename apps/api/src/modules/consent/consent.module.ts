import { Module } from '@nestjs/common';
import { ConsentController } from './consent.controller.js';
import { ConsentService } from './consent.service.js';

/** Đồng ý lại và rút đồng ý của thiết bị (M3.7). Văn bản đồng ý ở `consent-text.ts`. Xem README.md. */
@Module({
  controllers: [ConsentController],
  providers: [ConsentService],
})
export class ConsentModule {}

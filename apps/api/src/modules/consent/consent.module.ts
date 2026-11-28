import { Global, Module } from '@nestjs/common';
import { ConsentController } from './consent.controller.js';
import { ConsentService } from './consent.service.js';
import { MyDataController } from './my-data.controller.js';
import { MyDataService } from './my-data.service.js';
import { ConsentTextService } from './consent-text.service.js';

/** Đồng ý lại và rút đồng ý của thiết bị (M3.7). Văn bản đồng ý ở `consent-text.ts`. Xem README.md. */
@Global()
@Module({
  controllers: [ConsentController, MyDataController],
  providers: [ConsentService, MyDataService, ConsentTextService],
  exports: [ConsentTextService],
})
export class ConsentModule {}

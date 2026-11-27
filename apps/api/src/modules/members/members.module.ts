import { Module } from '@nestjs/common';
import { MembersController } from './members.controller.js';
import { MembersService } from './members.service.js';

/** Trang Thành viên kèm trạng thái thiết bị (M4.2). Xem README.md. */
@Module({
  controllers: [MembersController],
  providers: [MembersService],
})
export class MembersModule {}

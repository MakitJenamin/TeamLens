import { Module } from '@nestjs/common';
import { ProjectsController } from './projects.controller.js';
import { ProjectsService } from './projects.service.js';
import { UsersController } from './users.controller.js';

@Module({
  controllers: [ProjectsController, UsersController],
  providers: [ProjectsService],
  exports: [ProjectsService],
})
export class ProjectsModule {}

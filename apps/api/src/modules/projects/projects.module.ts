import { Module } from '@nestjs/common';
import { ProjectsController } from './projects.controller.js';
import { ProjectsService } from './projects.service.js';
import { UserMergeService } from './user-merge.service.js';
import { UsersController } from './users.controller.js';

@Module({
  controllers: [ProjectsController, UsersController],
  providers: [ProjectsService, UserMergeService],
  exports: [ProjectsService],
})
export class ProjectsModule {}
